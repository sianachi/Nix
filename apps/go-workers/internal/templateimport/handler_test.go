package templateimport

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importplan"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const (
	testImportID    = "11111111-1111-4111-8111-111111111111"
	testWorkspaceID = "22222222-2222-4222-8222-222222222222"
	testRootID      = "33333333-3333-4333-8333-333333333333"
	testChildID     = "44444444-4444-4444-8444-444444444444"
	testOperationID = "55555555-5555-4555-8555-555555555555"
	testTemplateID  = "66666666-6666-4666-8666-666666666666"
	testRootTarget  = "77777777-7777-4777-8777-777777777777"
	testChildTarget = "88888888-8888-4888-8888-888888888888"
)

func TestPreviewParsesAndUploadsDeterministicTemplatePlan(t *testing.T) {
	source := templateArchive(t, true)
	var uploaded []byte
	var completed workerapi.CompleteTemplateImportPreview
	var rejected atomic.Bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/template-imports/" + testImportID + "/preview":
			_ = json.NewEncoder(response).Encode(previewMetadata(server.URL, int64(len(source))))
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			if request.Method != http.MethodPut || request.Header.Get("X-Nix-Content-SHA256") == "" {
				t.Fatalf("plan upload method or digest header is invalid")
			}
			uploaded, _ = io.ReadAll(request.Body)
			response.WriteHeader(http.StatusNoContent)
		case "/internal/worker-executions/template-imports/" + testImportID + "/preview/complete":
			if err := json.NewDecoder(request.Body).Decode(&completed); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		case "/internal/worker-executions/template-imports/" + testImportID + "/reject":
			rejected.Store(true)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	result, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.preview", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	if err != nil {
		t.Fatal(err)
	}
	preview := result.(PreviewResult)
	if rejected.Load() || preview.ItemCount != 2 || preview.BodyCount != 2 || preview.ViewCount != 0 || preview.StableKey != "team.project" || len(uploaded) == 0 {
		t.Fatalf("result = %#v, rejected = %v, uploaded = %d", preview, rejected.Load(), len(uploaded))
	}
	if completed.Profile.Key != "team.project" || completed.ItemCount != 2 || completed.BodyCount != 2 || completed.SourceSHA256 != sourceDigest(source) || completed.PlanByteLength != int64(len(uploaded)) {
		t.Fatalf("completion = %#v", completed)
	}
	plan, err := importplan.DecodeTemplate(uploaded, completed.PlanSHA256, templateLimits())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Items[1].Sequence != "4096" || plan.Items[1].ParentSourceID == nil || *plan.Items[1].ParentSourceID != testRootID || !strings.Contains(string(plan.Items[1].Body), `"canvas"`) {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestCommitRevalidatesStagesWritesBodiesAndCompletes(t *testing.T) {
	source := templateArchive(t, true)
	planBody, planDigest := encodedTemplatePlan(t, source)
	sourceSHA := sourceDigest(source)
	var staged workerapi.TemplateImportStageRequest
	var bodyRequest struct {
		Writes []collaborationBodyWrite `json:"writes"`
	}
	var completion workerapi.CompleteTemplateImportRequest
	var rejected atomic.Bool
	operationID := testOperationID
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/template-imports/" + testImportID + "/commit":
			_ = json.NewEncoder(response).Encode(commitMetadata(server.URL, int64(len(source)), sourceSHA, int64(len(planBody)), planDigest))
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			_, _ = response.Write(planBody)
		case "/internal/worker-executions/template-imports/" + testImportID + "/stage":
			if err := json.NewDecoder(request.Body).Decode(&staged); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportStage{
				ImportID: testImportID, OperationID: &operationID, TemplateID: testTemplateID,
				StableKey: "team.project", Digest: sourceSHA,
				ItemMappings: []workerapi.TemplateImportBodyWrite{
					{SourceID: testRootID, TargetItemID: testRootTarget, ItemType: "note"},
					{SourceID: testChildID, TargetItemID: testChildTarget, ItemType: "canvas"},
				},
				BodyWrites: []workerapi.TemplateImportBodyWrite{
					{SourceID: testRootID, TargetItemID: testRootTarget, ItemType: "note"},
					{SourceID: testChildID, TargetItemID: testChildTarget, ItemType: "canvas"},
				},
			})
		case "/internal/worker-executions/template-imports/" + testImportID + "/bodies":
			if err := json.NewDecoder(request.Body).Decode(&bodyRequest); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"writtenTargetItemIds": []string{testChildTarget, testRootTarget},
			})
		case "/internal/worker-executions/template-imports/" + testImportID + "/complete":
			if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportResult{
				ImportID: testImportID, OperationID: &operationID, TemplateID: testTemplateID,
				StableKey: "team.project", Digest: sourceSHA, Unchanged: false,
				ItemCount: 2, BodyCount: 2,
				WrittenTargetItemIDs: []string{testChildTarget, testRootTarget},
			})
		case "/internal/worker-executions/template-imports/" + testImportID + "/reject":
			rejected.Store(true)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	result, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.commit", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	if err != nil {
		t.Fatal(err)
	}
	commit := result.(CommitResult)
	if rejected.Load() || commit.TemplateID != testTemplateID || commit.OperationID == nil || *commit.OperationID != testOperationID || commit.ItemCount != 2 || commit.BodyCount != 2 {
		t.Fatalf("result = %#v, rejected = %v", commit, rejected.Load())
	}
	if staged.Profile.Key != "team.project" || len(staged.Items) != 2 || !staged.Items[0].HasBody || staged.Items[1].Sequence != "4096" {
		t.Fatalf("stage request = %#v", staged)
	}
	if len(bodyRequest.Writes) != 2 || bodyRequest.Writes[0].SourceID != testRootID || !strings.Contains(string(bodyRequest.Writes[0].Body), `"prosemirror"`) || !strings.Contains(string(bodyRequest.Writes[1].Body), `"canvas"`) {
		t.Fatalf("body request = %#v", bodyRequest)
	}
	if !sameStringSet(completion.WrittenTargetItemIDs, []string{testRootTarget, testChildTarget}) {
		t.Fatalf("completion = %#v", completion)
	}
}

func TestCommitCompletesAnUnchangedTemplateWithoutRewritingBodies(t *testing.T) {
	source := templateArchive(t, false)
	planBody, planDigest := encodedTemplatePlan(t, source)
	sourceSHA := sourceDigest(source)
	var collaborationCalled atomic.Bool
	var completedIDs []string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/template-imports/" + testImportID + "/commit":
			_ = json.NewEncoder(response).Encode(commitMetadata(server.URL, int64(len(source)), sourceSHA, int64(len(planBody)), planDigest))
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			_, _ = response.Write(planBody)
		case "/internal/worker-executions/template-imports/" + testImportID + "/stage":
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportStage{
				ImportID: testImportID, TemplateID: testTemplateID, StableKey: "team.project",
				Digest: sourceSHA, Unchanged: true,
				ItemMappings: []workerapi.TemplateImportBodyWrite{{SourceID: testRootID, TargetItemID: testRootTarget, ItemType: "note"}},
				BodyWrites:   []workerapi.TemplateImportBodyWrite{},
			})
		case "/internal/worker-executions/template-imports/" + testImportID + "/bodies":
			collaborationCalled.Store(true)
			response.WriteHeader(http.StatusInternalServerError)
		case "/internal/worker-executions/template-imports/" + testImportID + "/complete":
			var completion workerapi.CompleteTemplateImportRequest
			_ = json.NewDecoder(request.Body).Decode(&completion)
			completedIDs = completion.WrittenTargetItemIDs
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportResult{
				ImportID: testImportID, TemplateID: testTemplateID, StableKey: "team.project",
				Digest: sourceSHA, Unchanged: true, ItemCount: 1, BodyCount: 1,
				WrittenTargetItemIDs: []string{},
			})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	result, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.commit", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	if err != nil {
		t.Fatal(err)
	}
	commit := result.(CommitResult)
	if !commit.Unchanged || commit.OperationID != nil || collaborationCalled.Load() || len(completedIDs) != 0 {
		t.Fatalf("result = %#v, collaboration = %v, completed ids = %#v", commit, collaborationCalled.Load(), completedIDs)
	}
}

func TestCommitReplaysDurableCompletedResultWithoutTouchingCapabilities(t *testing.T) {
	operationID := testOperationID
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		requests.Add(1)
		if request.URL.Path != "/internal/worker-executions/template-imports/"+testImportID+"/commit" {
			t.Fatalf("terminal replay touched %s", request.URL.Path)
		}
		_ = json.NewEncoder(response).Encode(workerapi.TemplateImportCommit{
			ImportID: testImportID,
			CompletedResult: &workerapi.TemplateImportResult{
				ImportID: testImportID, OperationID: &operationID, TemplateID: testTemplateID,
				StableKey: "team.project", Digest: strings.Repeat("a", 64), Unchanged: false,
				ItemCount: 2, BodyCount: 2,
				WrittenTargetItemIDs: []string{testRootTarget, testChildTarget},
			},
		})
	}))
	defer server.Close()

	result, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.commit", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	if err != nil {
		t.Fatal(err)
	}
	commit := result.(CommitResult)
	if requests.Load() != 1 || commit.TemplateID != testTemplateID || commit.ItemCount != 2 || commit.BodyCount != 2 || !sameStringSet(commit.WrittenTargetItemIDs, []string{testRootTarget, testChildTarget}) {
		t.Fatalf("requests = %d, result = %#v", requests.Load(), commit)
	}
}

func TestInvalidTemplateArchiveIsRejectedAsTerminal(t *testing.T) {
	source := []byte("not a zip archive")
	var rejectionCode string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/template-imports/" + testImportID + "/preview":
			_ = json.NewEncoder(response).Encode(previewMetadata(server.URL, int64(len(source))))
		case "/objects/source":
			_, _ = response.Write(source)
		case "/internal/worker-executions/template-imports/" + testImportID + "/reject":
			var rejection struct {
				Code string `json:"code"`
			}
			_ = json.NewDecoder(request.Body).Decode(&rejection)
			rejectionCode = rejection.Code
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	_, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.preview", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	var jobError *jobrunner.JobError
	if !errors.As(err, &jobError) || jobError.Retryable || jobError.Code != "template_archive_invalid" || rejectionCode != "template_archive_invalid" {
		t.Fatalf("error = %#v, rejection = %q", err, rejectionCode)
	}
}

func TestCoreOutageIsRetryableAndConflictSignalsLeaseLoss(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
	}{
		{name: "outage", status: http.StatusServiceUnavailable},
		{name: "lease conflict", status: http.StatusConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			var rejected atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				assertWorkerProof(t, request)
				if strings.HasSuffix(request.URL.Path, "/reject") {
					rejected.Store(true)
					response.WriteHeader(http.StatusNoContent)
					return
				}
				response.WriteHeader(test.status)
			}))
			defer server.Close()

			_, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
				Kind: "template.preview", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
			})
			if rejected.Load() {
				t.Fatal("transient or lease-loss response was rejected as terminal")
			}
			if test.status == http.StatusConflict {
				var responseError *workerapi.ResponseError
				if !errors.As(err, &responseError) || responseError.Status != http.StatusConflict {
					t.Fatalf("lease-loss error = %#v", err)
				}
				return
			}
			var jobError *jobrunner.JobError
			if !errors.As(err, &jobError) || !jobError.Retryable {
				t.Fatalf("outage error = %#v", err)
			}
		})
	}
}

func TestCommitCollaborationOutageIsRetryable(t *testing.T) {
	source := templateArchive(t, false)
	planBody, planDigest := encodedTemplatePlan(t, source)
	sourceSHA := sourceDigest(source)
	operationID := testOperationID
	var rejected atomic.Bool
	var completed atomic.Bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertWorkerProof(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/template-imports/" + testImportID + "/commit":
			_ = json.NewEncoder(response).Encode(commitMetadata(server.URL, int64(len(source)), sourceSHA, int64(len(planBody)), planDigest))
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			_, _ = response.Write(planBody)
		case "/internal/worker-executions/template-imports/" + testImportID + "/stage":
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportStage{
				ImportID: testImportID, OperationID: &operationID, TemplateID: testTemplateID,
				StableKey: "team.project", Digest: sourceSHA,
				ItemMappings: []workerapi.TemplateImportBodyWrite{{SourceID: testRootID, TargetItemID: testRootTarget, ItemType: "note"}},
				BodyWrites:   []workerapi.TemplateImportBodyWrite{{SourceID: testRootID, TargetItemID: testRootTarget, ItemType: "note"}},
			})
		case "/internal/worker-executions/template-imports/" + testImportID + "/bodies":
			response.WriteHeader(http.StatusServiceUnavailable)
		case "/internal/worker-executions/template-imports/" + testImportID + "/complete":
			completed.Store(true)
		case "/internal/worker-executions/template-imports/" + testImportID + "/reject":
			rejected.Store(true)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	_, err := testTemplateHandler(t, server.URL).Handle(executionContext(), workerapi.Job{
		Kind: "template.commit", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
	})

	var jobError *jobrunner.JobError
	if !errors.As(err, &jobError) || !jobError.Retryable || rejected.Load() || completed.Load() {
		t.Fatalf("error = %#v, rejected = %v, completed = %v", err, rejected.Load(), completed.Load())
	}
}

func TestPreviewAndCommitHonorCancellationWithoutRejecting(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	handler := testTemplateHandler(t, server.URL)
	for _, kind := range []string{"template.preview", "template.commit"} {
		ctx, cancel := context.WithCancel(executionContext())
		cancel()
		_, err := handler.Handle(ctx, workerapi.Job{
			Kind: kind, Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`),
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("%s cancellation error = %v", kind, err)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("cancelled handlers sent %d requests", requests.Load())
	}
}

func testTemplateHandler(t *testing.T, baseURL string) *Handler {
	t.Helper()
	handler, err := New(
		workerapi.New(baseURL, "secret", "worker", 5*time.Second),
		objecttransfer.New(5*time.Second),
		baseURL,
		"secret",
		templateLimits(),
		5*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func executionContext() context.Context {
	return workerapi.WithExecution(context.Background(), "job", "execution")
}

func previewMetadata(baseURL string, sourceBytes int64) workerapi.TemplateImportPreview {
	return workerapi.TemplateImportPreview{
		ImportID: testImportID, WorkspaceID: testWorkspaceID, Origin: "user", IdempotencyKey: "template:test",
		FileName: "project.nix", DeclaredMediaType: "application/x-nix-template", DeclaredByteLength: sourceBytes,
		SourceURL: baseURL + "/objects/source", SourceDeleteURL: baseURL + "/objects/source/delete",
		PlanUploadURL: baseURL + "/objects/plan", PlanDeleteURL: baseURL + "/objects/plan/delete",
		CapabilityExpires: time.Now().Add(time.Minute),
	}
}

func commitMetadata(baseURL string, sourceBytes int64, sourceSHA string, planBytes int64, planSHA string) workerapi.TemplateImportCommit {
	return workerapi.TemplateImportCommit{
		ImportID: testImportID, WorkspaceID: testWorkspaceID, Origin: "user", IdempotencyKey: "template:test",
		FileName: "project.nix", DeclaredMediaType: "application/x-nix-template", DeclaredByteLength: sourceBytes,
		SourceURL: baseURL + "/objects/source", SourceDeleteURL: baseURL + "/objects/source/delete",
		PlanUploadURL: baseURL + "/objects/plan/upload", PlanDeleteURL: baseURL + "/objects/plan/delete",
		CapabilityExpires: time.Now().Add(time.Minute), PlanSHA256: planSHA, PlanByteLength: planBytes,
		SourceSHA256: sourceSHA, PlanURL: baseURL + "/objects/plan",
	}
}

func encodedTemplatePlan(t *testing.T, archive []byte) ([]byte, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "project.nix")
	if err := os.WriteFile(path, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	plan, err := importplan.ParseTemplate(context.Background(), importplan.Source{
		Path: path, Format: "nix", Title: "project.nix", FileName: "project.nix",
		MediaType: "application/x-nix-template", Bytes: int64(len(archive)), SHA256: sourceDigest(archive),
	}, templateLimits())
	if err != nil {
		t.Fatal(err)
	}
	body, digest, err := importplan.EncodeTemplate(plan, templateLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	return body, digest
}

func templateArchive(t *testing.T, includeChild bool) []byte {
	t.Helper()
	profile := map[string]any{
		"kind": "template", "version": 1, "key": "team.project", "name": "Project",
		"description": "Reusable project", "includeBody": true, "includeChildren": includeChild,
	}
	items := []any{map[string]any{"id": testRootID, "parentId": nil, "seq": "2048", "title": "Project", "type": "note"}}
	if includeChild {
		items = append(items, map[string]any{"id": testChildID, "parentId": testRootID, "seq": "4096", "title": "Sketch", "type": "canvas"})
	}
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 3, "profile": profile,
		"exportedAt": "2026-09-01T12:00:00Z", "root": testRootID, "rootEffectiveSchema": nil,
		"includesDeleted": false, "items": items, "omitted": []any{}, "loss": []any{},
	}
	bundle := func(id string, parent *string, sequence, title, itemType string, body any) map[string]any {
		return map[string]any{
			"id": id, "parentId": parent, "workspaceId": testWorkspaceID, "type": itemType,
			"title": title, "seq": sequence, "lifecycleState": "active",
			"createdAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z",
			"properties": map[string]any{}, "schema": nil, "views": nil,
			"viewRows": []any{}, "viewRowsTruncated": false, "body": body,
		}
	}
	rootBody := map[string]any{"schemaVersion": 3, "prosemirror": map[string]any{"type": "doc", "content": []any{}}}
	manifestJSON, _ := json.Marshal(manifest)
	rootJSON, _ := json.Marshal(bundle(testRootID, nil, "2048", "Project", "note", rootBody))
	entries := []struct {
		name string
		body []byte
	}{{"manifest.json", manifestJSON}, {"items/" + testRootID + ".json", rootJSON}}
	if includeChild {
		parent := testRootID
		childBody := map[string]any{"schemaVersion": 1, "canvas": map[string]any{"version": 1, "elements": []any{}}}
		childJSON, _ := json.Marshal(bundle(testChildID, &parent, "4096", "Sketch", "canvas", childBody))
		entries = append(entries, struct {
			name string
			body []byte
		}{"items/" + testChildID + ".json", childJSON})
	}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

func templateLimits() importplan.Limits {
	return importplan.Limits{
		MaxSourceBytes: 100 << 20, MaxPlanBytes: 16 << 20, MaxBodyBytes: 8 << 20,
		MaxEntryBytes: 8 << 20, MaxItems: 10_000, MaxDepth: 32, PDFTimeoutSecs: 5,
	}
}

func assertWorkerProof(t *testing.T, request *http.Request) {
	t.Helper()
	if strings.HasPrefix(request.URL.Path, "/internal/") &&
		(request.Header.Get("X-Nix-Internal-Secret") != "secret" ||
			request.Header.Get("X-Nix-Worker-Job-Id") != "job" ||
			request.Header.Get("X-Nix-Worker-Execution-Id") != "execution") {
		t.Fatalf("execution headers for %s were incomplete", request.URL.Path)
	}
}

func sourceDigest(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}
