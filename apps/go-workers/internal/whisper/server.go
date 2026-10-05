package whisper

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os/exec"

	"github.com/sianachi/Nix/apps/go-workers/internal/speechcmd"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Options name the server binary and what it loads.
type Options struct {
	Binary   string
	Model    string
	VADModel string
	Threads  int
	// GPU is off for the CPU fallback and for development on a machine without one.
	GPU bool
	// Port is the loopback port the server listens on; zero picks a free one.
	Port int
}

// Server supervises one whisper.cpp server process and serialises access to it.
//
// The process is restarted when it exits. Callers take a turn before each request: an urgent
// caller (somebody dictating, waiting on the answer) goes ahead of a patient one (a meeting that
// has another fifty segments to go), which is the whole of the scheduling this needs.
type Server struct {
	options Options
	client  *Client
	logger  *slog.Logger
	ready   atomic.Bool

	turn    chan struct{}
	mu      sync.Mutex
	urgent  int
	settled *sync.Cond
}

func NewServer(options Options, logger *slog.Logger) (*Server, error) {
	if options.Binary == "" || options.Model == "" {
		return nil, errors.New("the whisper server binary and model are required")
	}
	if options.Threads <= 0 {
		options.Threads = 2
	}
	if options.Port == 0 {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		options.Port = listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
	}
	// No overall timeout: a long segment on a slow host is still an answer worth waiting for,
	// and every caller brings a context that bounds its own patience.
	httpClient := &http.Client{}
	server := &Server{
		options: options,
		client:  NewClient(httpClient, "http://127.0.0.1:"+strconv.Itoa(options.Port)),
		logger:  logger,
		turn:    make(chan struct{}, 1),
	}
	server.settled = sync.NewCond(&server.mu)
	return server, nil
}

// Ready reports whether the model is loaded and the server is answering.
func (server *Server) Ready() bool { return server.ready.Load() }

func (server *Server) arguments() []string {
	arguments := []string{
		"--model", server.options.Model,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(server.options.Port),
		"--threads", strconv.Itoa(server.options.Threads),
		"--language", "en",
		// Each clip is recognised on its own. Without this the decoder is primed with the text of
		// the request before, which here may be somebody else's dictation.
		"--no-context",
	}
	if server.options.VADModel != "" {
		arguments = append(arguments, "--vad", "--vad-model", server.options.VADModel)
	}
	if !server.options.GPU {
		arguments = append(arguments, "--no-gpu")
	}
	return arguments
}

// Run keeps the server process alive until the context ends.
func (server *Server) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := server.runOnce(ctx)
		server.ready.Store(false)
		if ctx.Err() != nil {
			return
		}
		server.logger.Error("the whisper server stopped", "error", err)
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (server *Server) runOnce(ctx context.Context) error {
	command := exec.CommandContext(ctx, server.options.Binary, server.arguments()...)
	// The same near-empty environment as the other speech commands: this process parses audio
	// somebody uploaded and has no use for the worker's credentials. Its output is discarded
	// rather than logged, because the server may print what it recognised.
	command.Env = speechcmd.Environment()
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	command.WaitDelay = 5 * time.Second
	if err := command.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-exited:
			return err
		case <-ticker.C:
			probe, cancel := context.WithTimeout(ctx, 2*time.Second)
			healthy := server.client.Healthy(probe)
			cancel()
			if healthy && !server.ready.Swap(true) {
				server.logger.Info("the whisper server is ready", "model", server.options.Model, "gpu", server.options.GPU)
			}
		}
	}
}

// Transcribe takes a turn and recognises one clip. Urgent callers are served before patient ones.
func (server *Server) Transcribe(ctx context.Context, clip Request, urgent bool) ([]Utterance, error) {
	if !server.Ready() {
		// Somebody dictating should be told at once; a meeting can wait out a model that is
		// still loading or a server that is restarting, and so not spend a retry on it.
		if urgent || !server.waitReady(ctx, 3*time.Minute) {
			return nil, ErrNotReady
		}
	}
	release, err := server.acquire(ctx, urgent)
	if err != nil {
		return nil, err
	}
	defer release()
	// A server that is alive but wedged would otherwise hold the one turn for as long as its
	// caller is prepared to wait, which for a meeting is hours. No clip takes this long.
	clipContext, cancel := context.WithTimeout(ctx, clipPatience(len(clip.WAV)))
	defer cancel()
	return server.client.Transcribe(clipContext, clip)
}

func (server *Server) waitReady(ctx context.Context, patience time.Duration) bool {
	deadline := time.NewTimer(patience)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for !server.Ready() {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
	return true
}

// clipPatience is ten times the clip's length and never under two minutes: generous for the
// processor fallback on a slow host, and still a bound.
func clipPatience(wavBytes int) time.Duration {
	const bytesPerSecond = 2 * 16000
	return max(2*time.Minute, 10*time.Duration(wavBytes/bytesPerSecond)*time.Second)
}

// ErrNotReady means the model is still loading or the server is restarting.
var ErrNotReady = errors.New("the whisper server is not ready")

func (server *Server) acquire(ctx context.Context, urgent bool) (func(), error) {
	if urgent {
		server.mu.Lock()
		server.urgent++
		server.mu.Unlock()
		defer func() {
			server.mu.Lock()
			server.urgent--
			server.settled.Broadcast()
			server.mu.Unlock()
		}()
	} else if err := server.waitForUrgent(ctx); err != nil {
		return nil, err
	}
	select {
	case server.turn <- struct{}{}:
		return func() { <-server.turn }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// waitForUrgent holds a patient caller back while anybody urgent is waiting for the turn.
func (server *Server) waitForUrgent(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() {
		server.mu.Lock()
		server.settled.Broadcast()
		server.mu.Unlock()
	})
	defer stop()
	server.mu.Lock()
	defer server.mu.Unlock()
	for server.urgent > 0 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		server.settled.Wait()
	}
	return ctx.Err()
}
