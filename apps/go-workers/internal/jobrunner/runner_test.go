package jobrunner

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

type handlerFunc func(context.Context, workerapi.Job) (any, error)

func (handler handlerFunc) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	return handler(ctx, job)
}

func TestRunnerLeasesHandlesAndCompletesJob(t *testing.T) {
	var leases atomic.Int32
	completion := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/internal/worker-dispatch/jobs/lease" {
			if leases.Add(1) == 1 {
				_, _ = io.WriteString(response, `[{"id":"job-1","kind":"import.nix","payload":{},"attempts":1}]`)
			} else {
				_, _ = io.WriteString(response, `[]`)
			}
			return
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		completion <- body
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := workerapi.New(server.URL, "secret", "worker", time.Second)
	runner, err := New(client, handlerFunc(func(context.Context, workerapi.Job) (any, error) {
		return map[string]any{"items": 2}, nil
	}), []string{"import.nix"}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { runner.Run(ctx); close(done) }()
	select {
	case body := <-completion:
		if body["succeeded"] != true {
			t.Fatalf("completion = %#v", body)
		}
	case <-time.After(time.Second):
		t.Fatal("job was not completed")
	}
	cancel()
	<-done
}

func TestRunnerRecordsCancellationWithoutCallingHandler(t *testing.T) {
	completion := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/internal/worker-dispatch/jobs/lease" {
			_, _ = io.WriteString(response, `[{"id":"job-1","kind":"export.nix","payload":{},"attempts":1,"cancellationRequested":true}]`)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		completion <- body
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	called := false
	runner, _ := New(workerapi.New(server.URL, "secret", "worker", time.Second), handlerFunc(func(context.Context, workerapi.Job) (any, error) {
		called = true
		return nil, nil
	}), []string{"export.nix"}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go runner.Run(ctx)
	select {
	case body := <-completion:
		cancel()
		if called || body["errorCode"] != "job_cancelled" {
			t.Fatalf("called = %v, completion = %#v", called, body)
		}
	case <-time.After(time.Second):
		cancel()
		t.Fatal("cancellation was not recorded")
	}
}
