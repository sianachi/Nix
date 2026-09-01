package httpserver

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/indexer"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
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

func TestReadinessReflectsDependencies(t *testing.T) {
	server := New(Dependencies{Ready: func() bool { return false }})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d", response.Code)
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

func TestJSONRebuildForwardsOneRestartableDurablePage(t *testing.T) {
	nextTenant := "20000000-0000-4000-8000-000000000002"
	nextItem := "40000000-0000-4000-8000-000000000004"
	control := &fakeIndexControl{page: &workerapi.IndexRebuildPage{Enqueued: 250, NextTenantID: &nextTenant, NextItemID: &nextItem, HasMore: true}}
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", MaxInputSize: 1024, MaxRecords: 10, MaxLineBytes: 256, IndexControl: control})
	request := httptest.NewRequest(http.MethodPost, "/v1/index/rebuild", strings.NewReader(`{"afterTenantId":"10000000-0000-4000-8000-000000000001","afterItemId":"30000000-0000-4000-8000-000000000003","limit":250}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted || control.request.Limit == nil || *control.request.Limit != 250 || !strings.Contains(response.Body.String(), `"nextTenantId":"20000000-0000-4000-8000-000000000002"`) || !strings.Contains(response.Body.String(), `"hasMore":true`) {
		t.Fatalf("request = %#v, response = %d %q", control.request, response.Code, response.Body.String())
	}
}

func TestIndexStatusCombinesDurableQueueAndConsumerProgress(t *testing.T) {
	oldest := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	control := &fakeIndexControl{status: &workerapi.IndexQueueStatus{Pending: 12, OldestAvailableAt: &oldest, HighestAttempts: 3, PendingFailures: 2}}
	server := New(Dependencies{
		Logger: slog.Default(), InternalSecret: "secret", IndexControl: control,
		IndexHealth: func() indexer.Health {
			return indexer.Health{Initialized: true, Consuming: true, Acknowledged: 30, Requeued: 2}
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/index/status", nil)
	request.Header.Set("X-Nix-Internal-Secret", "secret")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"pending":12`) || !strings.Contains(response.Body.String(), `"acknowledged":30`) || !strings.Contains(response.Body.String(), `"consuming":true`) {
		t.Fatalf("status response = %d %q", response.Code, response.Body.String())
	}
}

func TestJSONRebuildRejectsUnknownFieldsAndUnboundedPages(t *testing.T) {
	server := New(Dependencies{Logger: slog.Default(), InternalSecret: "secret", IndexControl: &fakeIndexControl{page: &workerapi.IndexRebuildPage{}}})
	for _, body := range []string{
		`{"limit":1001}`,
		`{"unknown":true}`,
		`{"afterTenantId":"10000000-0000-4000-8000-000000000001"}`,
		`{"afterTenantId":"tenant-1","afterItemId":"30000000-0000-4000-8000-000000000003"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/v1/index/rebuild", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Nix-Internal-Secret", "secret")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s returned %d %q", body, response.Code, response.Body.String())
		}
	}
}

type fakeIndexControl struct {
	request workerapi.IndexRebuildRequest
	page    *workerapi.IndexRebuildPage
	status  *workerapi.IndexQueueStatus
	err     error
}

func (control *fakeIndexControl) EnqueueIndexRebuild(_ context.Context, request workerapi.IndexRebuildRequest) (*workerapi.IndexRebuildPage, error) {
	control.request = request
	return control.page, control.err
}

func (control *fakeIndexControl) GetIndexStatus(context.Context) (*workerapi.IndexQueueStatus, error) {
	return control.status, control.err
}
