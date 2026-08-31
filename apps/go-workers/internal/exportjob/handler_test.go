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
	root := "123e4567-e89b-12d3-a456-426614174000"
	bundleStream := `{"format":"nix-archive","formatVersion":1,"schemaVersion":2,"exportedAt":"2026-08-31T00:00:00Z","root":"` + root + `","rootEffectiveSchema":null,"includesDeleted":false,"items":[{"id":"` + root + `","parentId":null,"seq":"1","title":"Title","type":"note"}],"omitted":[],"loss":[]}` + "\n" +
		`{"id":"` + root + `","parentId":null,"workspaceId":"workspace","type":"note","title":"Title","seq":"1","lifecycleState":"active","createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","properties":{},"schema":null,"views":null,"viewRows":[],"viewRowsTruncated":false,"body":{"schemaVersion":2,"prosemirror":{"type":"doc"}}}` + "\n" +
		`{"end":true,"items":1}` + "\n"
	uploaded := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			_, _ = io.WriteString(response, bundleStream)
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
