package httpserver

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/role"
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

func TestImportRoleDoesNotExposeOtherWorkerRoutes(t *testing.T) {
	server := NewForRole(role.Import, Dependencies{Logger: slog.Default(), InternalSecret: "secret"})
	for _, path := range []string{"/v1/export/ndjson", "/v1/search"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("X-Nix-Internal-Secret", "secret")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("import role exposed %s with status %d", path, response.Code)
		}
	}
}

func TestExportRoleDoesNotExposeOtherWorkerRoutes(t *testing.T) {
	server := NewForRole(role.Export, Dependencies{Logger: slog.Default(), InternalSecret: "secret"})
	for _, path := range []string{"/v1/import/ndjson", "/v1/search"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("X-Nix-Internal-Secret", "secret")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("export role exposed %s with status %d", path, response.Code)
		}
	}
}

func TestIndexerRoleDoesNotExposeImportOrExportRoutes(t *testing.T) {
	server := NewForRole(role.Index, Dependencies{Logger: slog.Default(), InternalSecret: "secret"})
	for _, path := range []string{"/v1/import/ndjson", "/v1/export/ndjson"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("X-Nix-Internal-Secret", "secret")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("indexer role exposed %s with status %d", path, response.Code)
		}
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

func TestWorkerPayloadRoutesRequireTheInternalSecret(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/ndjson", strings.NewReader(`{"id":"one","title":"One"}
`))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated response = %d", response.Code)
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

func TestDocumentImportParsesMarkdownWithHonestResponse(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, MaxTokens: 100})
	request := httptest.NewRequest(http.MethodPost, "/v1/import/document?format=markdown&id=one&title=Note", strings.NewReader("# Heading"))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"# Heading"`) {
		t.Fatalf("document import response = %d %q", response.Code, response.Body.String())
	}
}

func TestDocumentExportWritesMarkdown(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, MaxTokens: 100})
	request := httptest.NewRequest(http.MethodPost, "/v1/export/document?format=markdown", strings.NewReader(`{"id":"one","title":"Note","body":"Body"}
`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "# Note\n\nBody\n\n" {
		t.Fatalf("document export response = %d %q", response.Code, response.Body.String())
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

func TestIndexAndSearchRoutesReturnMatches(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, MaxTokens: 100})
	indexRequest := httptest.NewRequest(http.MethodPost, "/v1/index/ndjson", strings.NewReader(`{"id":"one","title":"Project plan"}
`))
	indexRequest.Header.Set("X-Nix-Internal-Secret", "secret")
	indexResponse := httptest.NewRecorder()
	server.ServeHTTP(indexResponse, indexRequest)
	if indexResponse.Code != http.StatusAccepted {
		t.Fatalf("index response = %d %q", indexResponse.Code, indexResponse.Body.String())
	}

	searchRequest := httptest.NewRequest(http.MethodGet, "/v1/search?q=project", nil)
	searchRequest.Header.Set("X-Nix-Internal-Secret", "secret")
	searchResponse := httptest.NewRecorder()
	server.ServeHTTP(searchResponse, searchRequest)
	if searchResponse.Code != http.StatusOK || !strings.Contains(searchResponse.Body.String(), `"one"`) {
		t.Fatalf("search response = %d %q", searchResponse.Code, searchResponse.Body.String())
	}
}

func TestRebuildAndSnapshotRoutesReplaceTheIndex(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, MaxTokens: 100})
	request := httptest.NewRequest(http.MethodPost, "/v1/index/rebuild", strings.NewReader(`{"id":"new","title":"New"}
`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("rebuild response = %d %q", response.Code, response.Body.String())
	}

	snapshotRequest := httptest.NewRequest(http.MethodGet, "/v1/index/snapshot", nil)
	snapshotRequest.Header.Set("X-Nix-Internal-Secret", "secret")
	snapshotResponse := httptest.NewRecorder()
	server.ServeHTTP(snapshotResponse, snapshotRequest)
	if snapshotResponse.Code != http.StatusOK || !strings.Contains(snapshotResponse.Body.String(), `"new"`) {
		t.Fatalf("snapshot response = %d %q", snapshotResponse.Code, snapshotResponse.Body.String())
	}
}

func TestRestoreRouteLoadsASnapshot(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, MaxTokens: 100})
	request := httptest.NewRequest(http.MethodPost, "/v1/index/restore", strings.NewReader(`{"version":1,"records":[{"id":"restored","title":"Restored"}]}`))
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("restore response = %d %q", response.Code, response.Body.String())
	}
	searchRequest := httptest.NewRequest(http.MethodGet, "/v1/search?q=restored", nil)
	searchRequest.Header.Set("X-Nix-Internal-Secret", "secret")
	searchResponse := httptest.NewRecorder()
	server.ServeHTTP(searchResponse, searchRequest)
	if !strings.Contains(searchResponse.Body.String(), `"restored"`) {
		t.Fatalf("search after restore = %q", searchResponse.Body.String())
	}
}
