package fileinspect

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestHandlerStreamsOpaqueFilesAndPublishesThroughTheLeaseBoundAPI(t *testing.T) {
	body := []byte{'M', 'Z', 0, 0, 1, 2, 3}
	var published workerapi.InspectedFile
	var immutable []byte
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/internal/worker-executions/") &&
			(request.Header.Get("X-Nix-Worker-Job-Id") != "job" || request.Header.Get("X-Nix-Worker-Execution-Id") != "execution") {
			t.Fatal("the worker execution proof was not forwarded")
		}
		switch request.URL.Path {
		case "/internal/worker-executions/files/uploads/upload":
			_ = json.NewEncoder(response).Encode(workerapi.FileInspection{
				UploadID: "upload", WorkspaceID: "workspace", Status: "inspection_queued",
				FileName: "photo.png", DeclaredMediaType: "image/png", DeclaredByteLength: int64(len(body)),
				ExpiresAt: time.Now().Add(time.Minute), SourceURL: server.URL + "/source", SourceDeleteURL: server.URL + "/source",
				DestinationURL: server.URL + "/destination", DestinationUploadURL: server.URL + "/destination",
				DestinationDeleteURL: server.URL + "/destination",
			})
		case "/source":
			if request.Method == http.MethodDelete {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			_, _ = response.Write(body)
		case "/destination":
			switch request.Method {
			case http.MethodPut:
				if request.Header.Get("If-None-Match") != "*" {
					t.Fatal("the immutable object precondition was not sent")
				}
				immutable, _ = io.ReadAll(request.Body)
				response.WriteHeader(http.StatusNoContent)
			case http.MethodGet:
				_, _ = response.Write(immutable)
			case http.MethodDelete:
				response.WriteHeader(http.StatusNoContent)
			default:
				response.WriteHeader(http.StatusMethodNotAllowed)
			}
		case "/internal/worker-executions/files/uploads/upload/publish":
			if err := json.NewDecoder(request.Body).Decode(&published); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(workerapi.PublishedFile{ItemID: "item", WorkspaceID: "workspace"})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	api := workerapi.New(server.URL, "secret", "worker", 2*time.Second)
	handler := New(api, objecttransfer.New(2*time.Second), 1024)
	ctx := workerapi.WithExecution(context.Background(), "job", "execution")

	result, err := handler.Handle(ctx, workerapi.Job{ID: "job", Kind: "file.publish", Payload: json.RawMessage(`{"uploadId":"upload"}`)})

	if err != nil {
		t.Fatal(err)
	}
	got := result.(Result)
	if got.ItemID != "item" || got.Previewable || got.DetectedMediaType != "application/octet-stream" || got.DeclaredMediaTypeConsistent {
		t.Fatalf("result = %#v", got)
	}
	if published.DetectedMediaType != "application/octet-stream" || published.Previewable || published.ByteLength != int64(len(body)) {
		t.Fatalf("published = %#v", published)
	}
	if string(immutable) != string(body) {
		t.Fatalf("immutable bytes = %q", immutable)
	}
}

func TestSizeMismatchIsRejectedAndDeleted(t *testing.T) {
	var rejected atomic.Bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/worker-executions/files/uploads/upload":
			_ = json.NewEncoder(response).Encode(workerapi.FileInspection{
				UploadID: "upload", WorkspaceID: "workspace", Status: "inspection_queued",
				FileName: "file.bin", DeclaredMediaType: "application/octet-stream", DeclaredByteLength: 20,
				ExpiresAt: time.Now().Add(time.Minute), SourceURL: server.URL + "/source", SourceDeleteURL: server.URL + "/source",
				DestinationURL: server.URL + "/destination", DestinationUploadURL: server.URL + "/destination",
				DestinationDeleteURL: server.URL + "/destination",
			})
		case "/source", "/destination":
			if request.Method == http.MethodDelete {
				t.Fatal("object cleanup must be performed by its own durable job")
			}
			if request.URL.Path == "/source" {
				_, _ = response.Write([]byte("short"))
				return
			}
			response.WriteHeader(http.StatusNotFound)
		case "/internal/worker-executions/files/uploads/upload/reject":
			rejected.Store(true)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	api := workerapi.New(server.URL, "secret", "worker", 2*time.Second)
	handler := New(api, objecttransfer.New(2*time.Second), 1024)

	_, err := handler.Handle(
		workerapi.WithExecution(context.Background(), "job", "execution"),
		workerapi.Job{ID: "job", Kind: "file.publish", Payload: json.RawMessage(`{"uploadId":"upload"}`)})

	var jobError *jobrunner.JobError
	if !errors.As(err, &jobError) || jobError.Code != "files.size_mismatch" || jobError.Retryable {
		t.Fatalf("error = %#v", err)
	}
	if !rejected.Load() {
		t.Fatal("the invalid upload was not durably rejected")
	}
}
