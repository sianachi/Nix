package importjob

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestHandlerDownloadsParsesAndStagesImport(t *testing.T) {
	uploaded := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			_, _ = io.WriteString(response, "hello")
			return
		}
		body, _ := io.ReadAll(request.Body)
		uploaded <- string(body)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	payload, _ := json.Marshal(Payload{SourceURL: server.URL, DestinationURL: server.URL, Format: "markdown", RootID: "root", Title: "Title"})
	handler := New(objecttransfer.New(time.Second), importer.Limits{MaxBytes: 1024, MaxItems: 10, MaxEntry: 1024}, stream.Limits{MaxBytes: 1024, MaxLine: 1024, MaxRecords: 10})
	result, err := handler.Handle(context.Background(), workerapi.Job{Kind: "import.markdown", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if result.(Result).Items != 1 || !strings.Contains(<-uploaded, `"body":"hello"`) {
		t.Fatalf("result = %#v", result)
	}
}

func TestHandlerPreviewDoesNotRequireDestination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(response, "hello") }))
	defer server.Close()
	payload, _ := json.Marshal(Payload{SourceURL: server.URL, Format: "markdown", RootID: "root", Title: "Title", Preview: true})
	handler := New(objecttransfer.New(time.Second), importer.Limits{MaxBytes: 1024, MaxItems: 10, MaxEntry: 1024}, stream.Limits{MaxBytes: 1024, MaxLine: 1024, MaxRecords: 10})
	result, err := handler.Handle(context.Background(), workerapi.Job{Kind: "import.markdown", Payload: payload})
	if err != nil || !result.(Result).Preview {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}
