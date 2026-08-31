package httpserver

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthzDoesNotRequireAWorkerPayload(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"healthy"`) {
		t.Fatalf("health response = %d %q", response.Code, response.Body.String())
	}
}

func TestImportValidatesNdjsonWithoutWritingToAStore(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"One"}
`))
	request.Header.Set("Content-Type", "application/x-ndjson")
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"records":1`) {
		t.Fatalf("import response = %d %q", response.Code, response.Body.String())
	}
}

func TestImportRefusesAnOversizedRecord(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 16})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"This title is too long"}
`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("import response = %d %q", response.Code, response.Body.String())
	}
}

func TestExportReturnsNdjsonRecords(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/export/ndjson", strings.NewReader(`{"id":"one","title":"One"}
`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	body, _ := io.ReadAll(response.Body)
	if response.Code != http.StatusOK || string(body) != `{"id":"one","title":"One"}
` {
		t.Fatalf("export response = %d %q", response.Code, body)
	}
}
