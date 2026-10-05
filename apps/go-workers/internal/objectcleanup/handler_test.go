package objectcleanup

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestCleanupDeletesOnlyTheCapabilitiesIssuedForTheExactJob(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	var deleted atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/internal/worker-executions/object-cleanup" &&
			(request.Header.Get("X-Nix-Worker-Job-Id") != "job" || request.Header.Get("X-Nix-Worker-Execution-Id") != "execution") {
			t.Fatal("the exact execution proof was not sent")
		}
		switch request.URL.Path {
		case "/internal/worker-executions/object-cleanup":
			_ = json.NewEncoder(response).Encode(workerapi.ObjectCleanupCapability{
				OwnerKind: "file-upload", OwnerID: "owner", NotBefore: now,
				DeleteURLs: []string{server.URL + "/objects/one", server.URL + "/objects/two"},
			})
		case "/objects/one", "/objects/two":
			if request.Method != http.MethodDelete {
				t.Fatalf("method = %s", request.Method)
			}
			deleted.Add(1)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	handler := New(
		workerapi.New(server.URL, "secret", "worker", time.Second),
		objecttransfer.New(time.Second),
	)
	handler.clock = func() time.Time { return now.Add(time.Second) }
	payload, _ := json.Marshal(Payload{
		OwnerKind: "file-upload", OwnerID: "owner", NotBefore: now,
		ObjectKeys: []string{"key-one", "key-two"},
	})

	result, err := handler.Handle(
		workerapi.WithExecution(context.Background(), "job", "execution"),
		workerapi.Job{Kind: "object.cleanup", Payload: payload},
	)

	if err != nil {
		t.Fatal(err)
	}
	if result.(Result).Deleted != 2 || deleted.Load() != 2 {
		t.Fatalf("result = %#v, deleted = %d", result, deleted.Load())
	}
}

func TestCleanupWaitsForTheCancellationSafetyDelay(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	handler := &Handler{clock: func() time.Time { return now }}
	payload, _ := json.Marshal(Payload{
		OwnerKind: "document-import", OwnerID: "owner", NotBefore: now.Add(time.Minute),
		ObjectKeys: []string{"key"},
	})

	_, err := handler.Handle(context.Background(), workerapi.Job{Kind: "object.cleanup", Payload: payload})

	var jobError *jobrunner.JobError
	if !errors.As(err, &jobError) || !jobError.Retryable || jobError.Code != "cleanup_not_ready" {
		t.Fatalf("error = %#v", err)
	}
}
