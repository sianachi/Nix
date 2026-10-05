package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The fixtures under testdata/speech are the speech role's contract with Core and, for the two
// that Collaboration touches, with Collaboration (ADR-0059). Core's transcription and speech
// tests post the request fixtures exactly and assert their responses carry exactly the fixture
// key sets; Collaboration's tests parse t3 and accept t4; and these tests prove the worker writes
// byte-identical requests and reads every field of the responses. Changing a fixture changes the
// contract on every side.

func readSpeechFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "speech", name+".json"))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		t.Fatalf("compact fixture %s: %v", name, err)
	}
	return compact.Bytes()
}

type recordedRequest struct {
	method string
	body   []byte
	header http.Header
}

func speechContractCore(t *testing.T, responses map[string]string) (*Client, map[string]recordedRequest) {
	t.Helper()
	requests := map[string]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		requests[request.URL.Path] = recordedRequest{method: request.Method, body: body, header: request.Header}
		fixture, ok := responses[request.URL.Path]
		if !ok {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(readSpeechFixture(t, fixture))
	}))
	t.Cleanup(server.Close)
	return New(server.URL, "contract-secret", "speech-worker", 5*time.Second), requests
}

func TestSpeechCapabilityRedeemMatchesTheContract(t *testing.T) {
	const path = "/internal/worker-dispatch/speech/capabilities/redeem"
	client, requests := speechContractCore(t, map[string]string{path: "s1_redeem_response"})

	grant, err := client.RedeemSpeechCapability(context.Background(), "CfDJ8-opaque-capability", SpeechDictate)

	if err != nil {
		t.Fatal(err)
	}
	sent := requests[path]
	if sent.method != http.MethodPost || !bytes.Equal(sent.body, readSpeechFixture(t, "s1_redeem_request")) {
		t.Fatalf("sent %s %s", sent.method, sent.body)
	}
	// No job stands behind a browser's request, so no execution is claimed.
	if sent.header.Get("X-Nix-Internal-Secret") != "contract-secret" || sent.header.Get("X-Nix-Worker-Job-Id") != "" {
		t.Fatalf("headers = %v", sent.header)
	}
	want := time.Date(2026, 10, 5, 14, 5, 0, 0, time.UTC)
	if grant.TenantID != "aaaaaaaa-0000-4000-8000-000000000001" || grant.PrincipalID != "bbbbbbbb-0000-4000-8000-000000000002" || !grant.ExpiresAt.Equal(want) {
		t.Fatalf("grant = %#v", grant)
	}
}

func TestTranscriptionSourceAndProgressMatchTheContract(t *testing.T) {
	const source = "/internal/worker-executions/transcriptions/source"
	const progress = "/internal/worker-executions/transcriptions/progress"
	client, requests := speechContractCore(t, map[string]string{source: "t1_source_response"})
	ctx := WithExecution(context.Background(), "job-1", "execution-1")

	got, err := client.GetTranscriptionSource(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := TranscriptionSource{
		SourceURL:   "https://objects.example.test/nix/files/versions/aaaaaaaa/cccccccc?X-Amz-Signature=abc",
		ByteLength:  1048576,
		AudioItemID: "cccccccc-0000-4000-8000-000000000003",
		NoteItemID:  "dddddddd-0000-4000-8000-000000000004",
		WorkspaceID: "eeeeeeee-0000-4000-8000-000000000005",
		Speakers:    "channels",
	}
	if *got != want {
		t.Fatalf("source = %#v", got)
	}
	// Every member of the fixture is one the worker reads: a field Core adds is noticed here.
	var members map[string]json.RawMessage
	if err := json.Unmarshal(readSpeechFixture(t, "t1_source_response"), &members); err != nil || len(members) != 6 {
		t.Fatalf("source fixture has %d members", len(members))
	}
	if sent := requests[source]; sent.method != http.MethodGet || sent.header.Get("X-Nix-Worker-Job-Id") != "job-1" || sent.header.Get("X-Nix-Worker-Execution-Id") != "execution-1" {
		t.Fatalf("source request = %s %v", sent.method, sent.header)
	}

	if err := client.ReportTranscriptionProgress(ctx, 42); err != nil {
		t.Fatal(err)
	}
	if sent := requests[progress]; sent.method != http.MethodPost || !bytes.Equal(sent.body, readSpeechFixture(t, "t2_progress_request")) {
		t.Fatalf("progress request = %s %s", sent.method, sent.body)
	}
	if err := client.ReportTranscriptionProgress(ctx, 250); err != nil {
		t.Fatal(err)
	}
	if sent := requests[progress]; string(sent.body) != `{"percent":100}` {
		t.Fatalf("an out-of-range percentage was sent as %s", sent.body)
	}
}

func TestSpeechRefusalsAndIncompleteAnswersAreErrors(t *testing.T) {
	refusing := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/internal/worker-dispatch/speech/capabilities/redeem" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(writer, `{"sourceUrl":"","byteLength":0}`)
	}))
	defer refusing.Close()
	client := New(refusing.URL, "secret", "worker", time.Second)

	if _, err := client.RedeemSpeechCapability(context.Background(), "token", SpeechSynthesize); err != ErrSpeechCapabilityRefused {
		t.Fatalf("err = %v", err)
	}
	// Core not accepting the worker itself is not the capability's fault and must not look like it.
	rejecting := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer rejecting.Close()
	if _, err := New(rejecting.URL, "wrong", "worker", time.Second).RedeemSpeechCapability(context.Background(), "token", SpeechSynthesize); err == nil || err == ErrSpeechCapabilityRefused {
		t.Fatalf("err = %v", err)
	}
	if _, err := client.GetTranscriptionSource(context.Background()); err == nil {
		t.Fatal("an incomplete source was accepted")
	}
}
