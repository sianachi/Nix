package exportjob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestHandlerObtainsLeaseBoundCapabilitiesAndPublishesAnImmutableExport(t *testing.T) {
	const jobID = "123e4567-e89b-12d3-a456-426614174099"
	const executionID = "exporter:execution"
	root := "123e4567-e89b-12d3-a456-426614174000"
	bundleStream := `{"format":"nix-archive","formatVersion":1,"schemaVersion":3,"exportedAt":"2026-08-31T00:00:00Z","root":"` + root + `","rootEffectiveSchema":null,"includesDeleted":false,"items":[{"id":"` + root + `","parentId":null,"seq":"1","title":"Title","type":"note"}],"omitted":[{"id":null,"parentId":"` + root + `","reason":"hidden","detail":"A child was unavailable."}],"loss":[{"itemId":"` + root + `","kind":"canvas","detail":"Canvas vectors were flattened."}]}` + "\n" +
		`{"id":"` + root + `","parentId":null,"workspaceId":"workspace","type":"note","title":"Title","seq":"1","lifecycleState":"active","createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","properties":{},"schema":null,"views":null,"viewRows":[],"viewRowsTruncated":false,"body":{"schemaVersion":2,"prosemirror":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Plan"}]},{"type":"paragraph","content":[{"type":"text","text":"Read "},{"type":"text","text":"carefully","marks":[{"type":"bold"}]},{"type":"image","attrs":{"src":"https://objects.example/diagram.png","alt":"Diagram","width":640,"height":480}}]},{"type":"details","content":[{"type":"detailsSummary","content":[{"type":"text","text":"More"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"Expanded"}]}]}]}]}}}` + "\n" +
		`{"end":true,"items":1}` + "\n"
	uploaded := make(chan []byte, 1)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/worker-executions/exports/" + jobID:
			assertWorkerRequest(t, request, jobID, executionID)
			writeJSON(t, response, map[string]any{
				"exportId": jobID, "format": "pdf", "sourceUrl": server.URL + "/bundle",
				"bearerToken": "delegated-token", "delegationExpiresAt": time.Now().Add(time.Minute),
			})
		case "/bundle":
			if request.Header.Get("Authorization") != "Bearer delegated-token" || request.Header.Get("X-Nix-Internal-Secret") != "secret" {
				t.Fatal("the Collaboration request did not carry both delegated proofs")
			}
			_, _ = io.WriteString(response, bundleStream)
		case "/internal/worker-executions/exports/" + jobID + "/destination":
			assertWorkerRequest(t, request, jobID, executionID)
			if request.URL.Query().Get("byteLength") == "" || request.URL.Query().Get("sha256") == "" {
				t.Fatal("destination request omitted the output length")
			}
			writeJSON(t, response, map[string]any{
				"exportId": jobID, "attemptId": "33333333-3333-4333-8333-333333333333", "format": "pdf", "objectKey": "exports/results/tenant/result.pdf",
				"uploadUrl": server.URL + "/result", "readUrl": server.URL + "/result",
				"deleteUrl": server.URL + "/result", "capabilityExpiresAt": time.Now().Add(time.Minute),
			})
		case "/result":
			if request.Header.Get("Authorization") != "" || request.Header.Get("X-Nix-Internal-Secret") != "" {
				t.Fatal("Collaboration credentials leaked to the object capability")
			}
			if request.Method != http.MethodPut || request.Header.Get("If-None-Match") != "*" {
				t.Fatalf("result request = %s, If-None-Match %q", request.Method, request.Header.Get("If-None-Match"))
			}
			body, _ := io.ReadAll(request.Body)
			uploaded <- body
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	payload, _ := json.Marshal(Payload{
		ItemID: root, WorkspaceID: "123e4567-e89b-12d3-a456-426614174001", Format: "pdf",
		Scope: "subtree", Title: "Title", Extension: "pdf", MediaType: "application/pdf",
		DeclaredLoss: []string{"Interactive workspace behavior is flattened into a document."},
	})
	handler := New(
		workerapi.New(server.URL, "secret", "exporter", time.Second),
		objecttransfer.New(time.Second, server.URL),
		objecttransfer.New(time.Second, server.URL),
		"secret",
		stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	ctx := workerapi.WithExecution(context.Background(), jobID, executionID)
	value, err := handler.Handle(ctx, workerapi.Job{ID: jobID, Kind: "export.pdf", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	output := <-uploaded
	result := value.(Result)
	if result.ItemCount != 1 || result.AttemptID == "" || result.Format != "pdf" || result.ObjectKey == "" || len(output) < 5 || string(output[:5]) != "%PDF-" {
		t.Fatalf("result = %#v, output bytes = %d", result, len(output))
	}
	for _, expected := range []string{
		"(Plan) Tj",
	} {
		if !strings.Contains(string(output), expected) {
			t.Fatalf("exported PDF omitted %q", expected)
		}
	}
	if !contains(result.Loss, "canvas: Canvas vectors were flattened.") ||
		!contains(result.Loss, "Images are linked or described rather than embedded in the converted document.") ||
		!contains(result.Omissions, "hidden: A child was unavailable.") {
		t.Fatalf("result reports = loss %#v, omissions %#v", result.Loss, result.Omissions)
	}
	digest := sha256.Sum256(output)
	if result.ByteLength != int64(len(output)) || result.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("result integrity = %d, %s", result.ByteLength, result.SHA256)
	}
}

func TestHandlerRefusesLegacyPayloadCapabilities(t *testing.T) {
	payload := json.RawMessage(`{"sourceUrl":"https://objects.example/source","destinationUrl":"https://objects.example/result","format":"pdf"}`)
	handler := New(nil, nil, nil, "", stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if _, err := handler.Handle(context.Background(), workerapi.Job{Kind: "export.pdf", Payload: payload}); err == nil {
		t.Fatal("legacy caller-supplied capabilities were accepted")
	}
}

func TestResultReportsStayInsideTheBrokerEnvelope(t *testing.T) {
	manifest := nixarchive.Manifest{
		Loss:    make([]nixarchive.LossEntry, 128),
		Omitted: make([]nixarchive.Omission, 1000),
	}
	for index := range manifest.Loss {
		manifest.Loss[index] = nixarchive.LossEntry{Kind: "format", Detail: strings.Repeat("é", 250)}
	}
	for index := range manifest.Omitted {
		manifest.Omitted[index] = nixarchive.Omission{Reason: "hidden", Detail: strings.Repeat("é", 250)}
	}
	loss := lossMessages("pdf", manifest, []string{"Projection changed."})
	omissions := omissionMessages(manifest)
	if len(loss) > maximumResultReportEntries || len(omissions) > maximumResultReportEntries {
		t.Fatalf("report sizes = %d, %d", len(loss), len(omissions))
	}
	for _, entry := range append(loss, omissions...) {
		if len(entry) > maximumResultReportBytes || !utf8.ValidString(entry) {
			t.Fatalf("invalid bounded report entry: %q", entry)
		}
	}
	payload, err := json.Marshal(Result{Format: "pdf", Loss: loss, Omissions: omissions})
	if err != nil || len(payload) >= 64*1024 {
		t.Fatalf("result envelope bytes = %d, %v", len(payload), err)
	}
}

func assertWorkerRequest(t *testing.T, request *http.Request, jobID, executionID string) {
	t.Helper()
	if request.Header.Get("X-Nix-Internal-Secret") != "secret" ||
		request.Header.Get("X-Nix-Worker-Job-Id") != jobID ||
		request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
		t.Fatalf("worker proof headers = %#v", request.Header)
	}
}

func writeJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
