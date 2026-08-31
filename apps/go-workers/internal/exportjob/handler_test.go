package exportjob

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestHandlerDownloadsBundleAndUploadsExport(t *testing.T) {
	uploaded := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			_, _ = io.WriteString(response, `{"id":"one","title":"Title","body":"Body"}`+"\n")
			return
		}
		body, _ := io.ReadAll(request.Body)
		uploaded <- body
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	payload, _ := json.Marshal(Payload{SourceURL: server.URL, DestinationURL: server.URL, Format: "pdf"})
	handler := New(objecttransfer.New(time.Second), stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	result, err := handler.Handle(context.Background(), workerapi.Job{Kind: "export.pdf", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	output := <-uploaded
	if result.(Result).Items != 1 || len(output) < 5 || string(output[:5]) != "%PDF-" {
		t.Fatalf("result = %#v", result)
	}
}
