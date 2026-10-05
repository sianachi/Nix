package documentimport

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/importplan"
	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const testImportID = "11111111-1111-4111-8111-111111111111"

func TestPreviewDownloadsParsesAndPublishesOnlyThePlan(t *testing.T) {
	source := []byte("one\r\ntwo")
	var planBody []byte
	var completed workerapi.CompleteDocumentImportPreview
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertExecution(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/imports/" + testImportID + "/preview":
			_ = json.NewEncoder(response).Encode(workerapi.DocumentImportPreview{
				ImportID: testImportID, Format: "txt", Title: "Imported", FileName: "notes.txt",
				DeclaredMediaType: "text/plain", DeclaredByteLength: int64(len(source)),
				SourceURL: server.URL + "/objects/source", SourceDeleteURL: server.URL + "/objects/source",
				PlanUploadURL: server.URL + "/objects/plan", PlanDeleteURL: server.URL + "/objects/plan",
				CapabilityExpires: time.Now().Add(time.Minute),
			})
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			var err error
			planBody, err = io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
		case "/internal/worker-executions/imports/" + testImportID + "/preview/complete":
			if err := json.NewDecoder(request.Body).Decode(&completed); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	handler := testHandler(t, server.URL)

	result, err := handler.Handle(
		workerapi.WithExecution(context.Background(), "job", "execution"),
		workerapi.Job{Kind: "import.preview.txt", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`)},
	)

	if err != nil {
		t.Fatal(err)
	}
	preview := result.(PreviewResult)
	if preview.Items != 2 || preview.Assets != 0 || len(planBody) == 0 {
		t.Fatalf("result = %#v, plan bytes = %d", preview, len(planBody))
	}
	if completed.PlanByteLength != int64(len(planBody)) || completed.ItemCount != 2 || completed.SourceSHA256 == "" {
		t.Fatalf("completion = %#v", completed)
	}
	plan, err := importplan.Decode(planBody, completed.PlanSHA256, testImportLimits())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Items[0].Body == nil || plan.Items[0].Body.Text != "one\ntwo" || plan.Items[1].File == nil || plan.Items[1].File.SourceKind != "source" {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestCommitRevalidatesStagesWritesBodiesAndFinalizes(t *testing.T) {
	source := []byte("durable text")
	sourceDigest := digest(source)
	parent := "root"
	plan := importplan.Plan{
		Version: importplan.Version, Format: "txt", Title: "Imported", SourceSHA256: sourceDigest,
		Items: []importplan.Item{
			{SourceID: "root", Order: 0, Title: "Imported", ItemType: "note", FinalLifecycleState: "active", Body: &importplan.Body{Encoding: "plain_text", Text: "durable text"}},
			{SourceID: "original", ParentSourceID: &parent, Order: 0, Title: "notes.txt", ItemType: "file", FinalLifecycleState: "active", File: &importplan.File{SourceKind: "source", FileName: "notes.txt", MediaType: "text/plain", ByteLength: int64(len(source)), SHA256: sourceDigest}},
		}, Loss: []string{}, Omissions: []string{},
	}
	planBody, planDigest, err := importplan.Encode(plan, 16<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceSHA256, err := hex.DecodeString(sourceDigest)
	if err != nil {
		t.Fatal(err)
	}
	expectedStorageChecksum := base64.StdEncoding.EncodeToString(sourceSHA256)
	rootTarget := "22222222-2222-4222-8222-222222222222"
	fileTarget := "33333333-3333-4333-8333-333333333333"
	var staged workerapi.DocumentImportStageRequest
	var collabWrites struct {
		Writes []bodyWrite `json:"writes"`
	}
	var finalized atomic.Bool
	var objectCompleted atomic.Bool
	var publishedSource []byte
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertExecution(t, request)
		switch request.URL.Path {
		case "/internal/worker-executions/imports/" + testImportID + "/commit":
			_ = json.NewEncoder(response).Encode(workerapi.DocumentImportCommit{
				ImportID: testImportID, Format: "txt", Title: "Imported", FileName: "notes.txt",
				DeclaredMediaType: "text/plain", DeclaredByteLength: int64(len(source)), SourceSHA256: sourceDigest,
				PlanSHA256: planDigest, PlanByteLength: int64(len(planBody)),
				SourceURL: server.URL + "/objects/source", SourceDeleteURL: server.URL + "/objects/source",
				PlanURL: server.URL + "/objects/plan", PlanDeleteURL: server.URL + "/objects/plan",
				CapabilityExpires: time.Now().Add(time.Minute),
			})
		case "/objects/source":
			_, _ = response.Write(source)
		case "/objects/plan":
			_, _ = response.Write(planBody)
		case "/objects/source-version":
			switch request.Method {
			case http.MethodPut:
				if request.Header.Get("If-None-Match") != "*" {
					t.Fatal("the source original was not published immutably")
				}
				if request.Header.Get("X-Amz-Checksum-Sha256") != expectedStorageChecksum {
					t.Fatalf("storage checksum = %q", request.Header.Get("X-Amz-Checksum-Sha256"))
				}
				publishedSource, _ = io.ReadAll(request.Body)
				response.WriteHeader(http.StatusNoContent)
			case http.MethodGet:
				_, _ = response.Write(publishedSource)
			case http.MethodDelete:
				response.WriteHeader(http.StatusNoContent)
			default:
				response.WriteHeader(http.StatusMethodNotAllowed)
			}
		case "/internal/worker-executions/imports/" + testImportID + "/stage":
			if err := json.NewDecoder(request.Body).Decode(&staged); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(workerapi.DocumentImportStage{
				ImportID: testImportID, RootItemID: rootTarget,
				Items: []workerapi.DocumentImportStageMapping{
					{SourceID: "root", TargetItemID: rootTarget, ItemType: "note", BodyRequired: true, ObjectReady: true},
					{SourceID: "original", TargetItemID: fileTarget, ItemType: "file", BodyRequired: false, ObjectReady: false},
				},
			})
		case "/internal/worker-executions/imports/" + testImportID + "/objects/capability":
			if request.URL.Query().Get("sourceId") != "original" {
				t.Fatalf("sourceId = %q", request.URL.Query().Get("sourceId"))
			}
			_ = json.NewEncoder(response).Encode(workerapi.DocumentImportObjectCapability{
				SourceID: "original", URL: server.URL + "/objects/source-version",
				UploadURL: server.URL + "/objects/source-version", DeleteURL: server.URL + "/objects/source-version",
				CapabilityExpires: time.Now().Add(time.Minute),
			})
		case "/internal/worker-executions/imports/" + testImportID + "/objects/complete":
			objectCompleted.Store(true)
			response.WriteHeader(http.StatusNoContent)
		case "/internal/imports/" + testImportID + "/bodies":
			if err := json.NewDecoder(request.Body).Decode(&collabWrites); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(map[string]int{"written": 1})
		case "/internal/worker-executions/imports/" + testImportID + "/finalize":
			finalized.Store(true)
			_ = json.NewEncoder(response).Encode(workerapi.DocumentImportResult{ID: testImportID, Status: "completed", RootItemID: &rootTarget})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	handler := testHandler(t, server.URL)

	result, err := handler.Handle(
		workerapi.WithExecution(context.Background(), "job", "execution"),
		workerapi.Job{Kind: "import.commit", Payload: json.RawMessage(`{"importId":"` + testImportID + `"}`)},
	)

	if err != nil {
		t.Fatal(err)
	}
	commit := result.(CommitResult)
	if commit.RootItemID != rootTarget || commit.Items != 2 || !finalized.Load() {
		t.Fatalf("result = %#v, finalized = %v", commit, finalized.Load())
	}
	if string(publishedSource) != string(source) || !objectCompleted.Load() {
		t.Fatalf("published source = %q, completed = %v", publishedSource, objectCompleted.Load())
	}
	if len(staged.Items) != 2 || !staged.Items[0].BodyRequired || staged.Items[1].File == nil {
		t.Fatalf("stage = %#v", staged)
	}
	if len(collabWrites.Writes) != 1 || collabWrites.Writes[0].SourceID != "root" || collabWrites.Writes[0].Body.Text != "durable text" {
		t.Fatalf("body writes = %#v", collabWrites)
	}
}

func TestArchiveFileVersionsUploadVerifyAndAcknowledgePerVersion(t *testing.T) {
	const sourceID = "11111111-1111-4111-8111-111111111111"
	const targetID = "22222222-2222-4222-8222-222222222222"
	transferIDs := []string{"33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"}
	versions := []struct {
		version      int
		size         int64
		digest, text string
	}{
		{1, 20, "e44788cbbfd29389d597b72c023af1f02e33957f4268dec483bb5016095a7e7b", "%PDF-1.5\nold version"},
		{2, 24, "87bf031eea39c63fe21114134da65932eea8449eb9219638f8e94d4203ba9b0f", "%PDF-1.5\ncurrent version"},
	}
	uploaded := make(map[string][]byte)
	completed := []string{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		assertExecution(t, request)
		switch {
		case request.URL.Path == "/internal/worker-executions/imports/"+testImportID+"/file-versions/authorization":
			response.Header().Set("Content-Type", "application/json")
			files := make([]workerapi.TemplateImportFileCapability, 0, len(versions))
			for index, version := range versions {
				uploadURL, verifyURL := server.URL+"/objects/"+transferIDs[index], server.URL+"/verify/"+transferIDs[index]
				files = append(files, workerapi.TemplateImportFileCapability{
					TransferID: transferIDs[index], SourceItemID: sourceID, TargetItemID: targetID, TargetVersion: version.version,
					FileName: "report.pdf", MediaType: "application/pdf", ByteLength: version.size, SHA256: version.digest,
					UploadURL: &uploadURL, VerifyURL: &verifyURL,
				})
			}
			_ = json.NewEncoder(response).Encode(workerapi.TemplateImportFilePlan{ImportID: testImportID, Files: files, Complete: true})
		case request.URL.Path == "/internal/worker-executions/imports/"+testImportID+"/file-versions/complete":
			response.Header().Set("Content-Type", "application/json")
			var body struct {
				TransferIDs []string `json:"transferIds"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body.TransferIDs) != 1 {
				t.Fatalf("expected per-version durable ack, got %v", body.TransferIDs)
			}
			completed = append(completed, body.TransferIDs...)
			_ = json.NewEncoder(response).Encode(map[string]any{"importId": testImportID, "completedTransferIds": body.TransferIDs})
		case strings.HasPrefix(request.URL.Path, "/objects/") && request.Method == http.MethodPut:
			transferID := strings.TrimPrefix(request.URL.Path, "/objects/")
			if request.Header.Get("If-None-Match") != "*" {
				t.Fatal("file version upload was not conditional")
			}
			uploaded[transferID], _ = io.ReadAll(request.Body)
			response.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(request.URL.Path, "/verify/") && request.Method == http.MethodGet:
			transferID := strings.TrimPrefix(request.URL.Path, "/verify/")
			bytes, ok := uploaded[transferID]
			if !ok {
				response.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = response.Write(bytes)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	handler := testHandler(t, server.URL)
	archivePath := filepath.Join("../../../../fixtures", "nix-archive-v2-file.nix")
	descriptors := []nixarchive.FileVersionEntry{
		{ItemID: sourceID, Version: 1, FileName: "report.pdf", MediaType: "application/pdf", ByteLength: versions[0].size, SHA256: versions[0].digest, Previewable: true},
		{ItemID: sourceID, Version: 2, FileName: "report.pdf", MediaType: "application/pdf", ByteLength: versions[1].size, SHA256: versions[1].digest, Previewable: true},
	}
	stage := &workerapi.DocumentImportStage{FileTransfers: []workerapi.TemplateImportFileTransferMapping{
		{TransferID: transferIDs[0], SourceItemID: sourceID, TargetItemID: targetID, TargetVersion: 1},
		{TransferID: transferIDs[1], SourceItemID: sourceID, TargetItemID: targetID, TargetVersion: 2},
	}}
	err := handler.transferArchiveFileVersions(workerapi.WithExecution(context.Background(), "job", "execution"), testImportID, archivePath, descriptors, stage)
	if err != nil {
		t.Fatal(err)
	}
	if len(completed) != 2 || completed[0] != transferIDs[0] || completed[1] != transferIDs[1] {
		t.Fatalf("completed transfers = %v", completed)
	}
	for index, version := range versions {
		if string(uploaded[transferIDs[index]]) != version.text {
			t.Fatalf("version %d bytes = %q", version.version, uploaded[transferIDs[index]])
		}
	}
}

func testHandler(t *testing.T, serverURL string) *Handler {
	t.Helper()
	handler, err := New(
		workerapi.New(serverURL, "secret", "worker", 5*time.Second),
		objecttransfer.New(5*time.Second),
		serverURL,
		"secret",
		testImportLimits(),
		5*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func testImportLimits() importplan.Limits {
	return importplan.Limits{
		MaxSourceBytes: 100 << 20, MaxPlanBytes: 16 << 20, MaxBodyBytes: 8 << 20,
		MaxEntryBytes: 8 << 20, MaxItems: 10_000, MaxDepth: 32, PDFTimeoutSecs: 5,
	}
}

func assertExecution(t *testing.T, request *http.Request) {
	t.Helper()
	if strings.HasPrefix(request.URL.Path, "/internal/") &&
		(request.Header.Get("X-Nix-Internal-Secret") != "secret" ||
			request.Header.Get("X-Nix-Worker-Job-Id") != "job" ||
			request.Header.Get("X-Nix-Worker-Execution-Id") != "execution") {
		t.Fatalf("execution headers for %s were incomplete", request.URL.Path)
	}
}

func digest(body []byte) string {
	value := sha256.Sum256(body)
	return hex.EncodeToString(value[:])
}
