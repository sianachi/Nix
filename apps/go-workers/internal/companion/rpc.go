// Package companion manages private ChatGPT sessions inside the existing worker.
package companion

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Transport is the narrow provider seam. Tests use an in-memory protocol peer.
type Transport interface {
	Call(context.Context, string, any) (json.RawMessage, error)
	Close() error
}

type rpc struct {
	cmd       *exec.Cmd
	in        io.WriteCloser
	mu        sync.Mutex
	writeMu   sync.Mutex
	next      int
	pending   map[string]chan packet
	done      chan struct{}
	requestMu sync.RWMutex
	request   func(json.RawMessage, string, json.RawMessage) bool
}

type packet struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func launch(ctx context.Context, binary, home string, notify func(string, json.RawMessage)) (Transport, error) {
	work := filepath.Join(home, "empty")
	if err := os.MkdirAll(work, 0700); err != nil {
		return nil, err
	}
	args := []string{"app-server", "--listen", "stdio://", "-c", "cli_auth_credentials_store=\"file\"", "-c", "web_search=\"disabled\"", "-c", "tools.view_image=false", "-c", "sandbox_mode=\"read-only\"", "-c", "approval_policy=\"on-request\"", "-c", "forced_login_method=\"chatgpt\""}
	// No ambient user configuration, inherited provider credentials, plugins, or host tools.
	for _, feature := range []string{"shell_tool", "unified_exec", "shell_snapshot", "code_mode", "multi_agent", "multi_agent_v2", "apps", "hooks", "browser_use", "computer_use", "image_generation", "skill_search", "skill_mcp_dependency_install", "tool_suggest"} {
		args = append(args, "-c", "features."+feature+"=false")
	}
	// The pinned runtime dispatches dynamic tools through its code-mode host even
	// when code_mode is disabled. It needs this dispatcher to reach nix_workspace;
	// shell, network/browser tools and every other server request remain denied.
	args = append(args, "-c", "features.code_mode_host=true")
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = work
	cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "TMPDIR=" + work, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"}
	cmd.WaitDelay = 2 * time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		_ = in.Close()
		return nil, err
	}
	// Provider stderr can contain account data. Never forward it to shared worker logs.
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		_ = in.Close()
		return nil, err
	}
	r := &rpc{cmd: cmd, in: in, pending: map[string]chan packet{}, done: make(chan struct{})}
	go func() {
		defer close(r.done)
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			var p packet
			if json.Unmarshal(scanner.Bytes(), &p) != nil {
				break
			}
			if p.Method != "" {
				if len(p.ID) > 0 {
					r.requestMu.RLock()
					handler := r.request
					r.requestMu.RUnlock()
					if handler == nil || !handler(p.ID, p.Method, p.Params) {
						_ = r.write(map[string]any{"id": p.ID, "error": map[string]any{"code": -32601, "message": "Only the approved Nix workspace tool is available."}})
					}
				} else {
					notify(p.Method, p.Params)
				}
			} else {
				r.mu.Lock()
				ch := r.pending[string(p.ID)]
				r.mu.Unlock()
				if ch != nil {
					select {
					case ch <- p:
					default:
					}
				}
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err = r.Call(initCtx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "nix_companion", "version": "1.0.0"}, "capabilities": map[string]bool{"experimentalApi": true}}); err != nil {
		_ = r.Close()
		return nil, err
	}
	if err = r.write(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		_ = r.Close()
		return nil, err
	}
	return r, nil
}

func (r *rpc) SetRequestHandler(handler func(json.RawMessage, string, json.RawMessage) bool) {
	r.requestMu.Lock()
	r.request = handler
	r.requestMu.Unlock()
}

func (r *rpc) Reply(id json.RawMessage, result any) error {
	return r.write(map[string]any{"id": id, "result": result})
}

func (r *rpc) write(value any) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return json.NewEncoder(r.in).Encode(value)
}

func (r *rpc) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	r.mu.Lock()
	r.next++
	id := r.next
	key := strconv.Itoa(id)
	ch := make(chan packet, 1)
	r.pending[key] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, key); r.mu.Unlock() }()
	if err := r.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-r.done:
		return nil, errors.New("companion process stopped")
	case p := <-ch:
		if len(p.Error) > 0 && string(p.Error) != "null" {
			return nil, fmt.Errorf("provider refused %s", method)
		}
		return p.Result, nil
	}
}

func (r *rpc) Close() error {
	_ = r.in.Close()
	_ = r.cmd.Process.Kill()
	select {
	case <-r.done:
	case <-time.After(3 * time.Second):
	}
	return nil
}

func (r *rpc) Alive() bool {
	select {
	case <-r.done:
		return false
	default:
		return true
	}
}
