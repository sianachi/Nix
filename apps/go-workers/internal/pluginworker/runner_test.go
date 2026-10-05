package pluginworker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

func TestRunnerUsesOneBoundedConsumerPerConcurrencySlot(t *testing.T) {
	consumer := &recordingConsumer{started: make(chan struct{}, 3)}
	worker := newTestWorker(t, &fakeAPI{}, "http://127.0.0.1:1")
	runner, err := NewRunner(consumer, worker, "plugin-worker", 3, time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		runner.Run(ctx)
		close(done)
	}()
	for range 3 {
		select {
		case <-consumer.started:
		case <-time.After(time.Second):
			t.Fatal("plugin consumer did not start")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("plugin runner did not stop")
	}

	consumer.mu.Lock()
	defer consumer.mu.Unlock()
	if len(consumer.names) != 3 {
		t.Fatalf("consumer names = %#v", consumer.names)
	}
	unique := map[string]struct{}{}
	for _, name := range consumer.names {
		unique[name] = struct{}{}
	}
	if len(unique) != 3 {
		t.Fatalf("consumer names are not unique: %#v", consumer.names)
	}
}

func TestNewRunnerRejectsUnboundedConcurrency(t *testing.T) {
	worker := newTestWorker(t, &fakeAPI{}, "http://127.0.0.1:1")
	if _, err := NewRunner(&recordingConsumer{}, worker, "worker", 101, time.Second, slog.Default()); err == nil {
		t.Fatal("runner accepted unbounded concurrency")
	}
}

type recordingConsumer struct {
	mu      sync.Mutex
	names   []string
	started chan struct{}
}

func (consumer *recordingConsumer) Consume(ctx context.Context, queue, name string, prefetch int, handler broker.Handler) error {
	if queue != broker.PluginEventsQueue || prefetch != 1 || handler == nil {
		return errors.New("unexpected consumer configuration")
	}
	consumer.mu.Lock()
	consumer.names = append(consumer.names, name)
	consumer.mu.Unlock()
	consumer.started <- struct{}{}
	<-ctx.Done()
	return ctx.Err()
}
