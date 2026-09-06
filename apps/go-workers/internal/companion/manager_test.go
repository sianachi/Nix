package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fakeTransport struct {
	mu     sync.Mutex
	calls  []string
	params []any
}

func (f *fakeTransport) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method)
	f.params = append(f.params, params)
	switch method {
	case "account/login/start":
		return json.RawMessage(`{"loginId":"login","verificationUrl":"https://auth.openai.com/codex/device","userCode":"1234-ABCD"}`), nil
	case "account/read":
		return json.RawMessage(`{"account":{"type":"chatgpt"}}`), nil
	case "thread/start", "thread/resume":
		return json.RawMessage(`{"thread":{"id":"provider-thread"}}`), nil
	case "turn/start":
		return json.RawMessage(`{"turn":{"id":"provider-turn"}}`), nil
	default:
		return json.RawMessage(`{}`), nil
	}
}
func (f *fakeTransport) Close() error { return nil }

func request() Request {
	return Request{TenantID: "11111111-1111-4111-8111-111111111111", PrincipalID: "22222222-2222-4222-8222-222222222222", WorkspaceID: "33333333-3333-4333-8333-333333333333", PetID: "44444444-4444-4444-8444-444444444444", RequestID: "55555555-5555-4555-8555-555555555555", Operation: "send", Text: "Help me write", Instructions: "Be calm and concise"}
}

func TestPreActionCommentaryIsVisibleOnceWithoutAnotherPermissionCard(t *testing.T) {
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	commentary := json.RawMessage(`{"threadId":"provider-thread","item":{"id":"explanation","type":"agentMessage","phase":"commentary","text":"I will create a release note with the outline you requested."}}`)
	a.notify("item/completed", commentary)
	a.notify("item/completed", commentary)
	if got := a.snapshot(key); len(got.Messages) != 2 || got.State != "thinking" || len(got.Messages[1].Actions) != 0 {
		t.Fatalf("bad commentary: %+v", got)
	}
	if len(a.snapshot(key).Messages[1].ID) > 80 {
		t.Fatal("commentary ID exceeds client contract")
	}
	a.conversations[key].Tools = []ToolCall{{ID: "tool", Status: "completed"}}
	a.notify("item/completed", json.RawMessage(`{"threadId":"provider-thread","item":{"type":"agentMessage","phase":"final_answer","text":"{\"answer\":\"Created.\",\"actions\":[{\"kind\":\"create_item\",\"itemId\":\"\",\"title\":\"Release\"}]}"}}`))
	if len(a.snapshot(key).Messages[2].Actions) != 0 {
		t.Fatal("legacy card asked again after a tool")
	}
}

func TestStructuredCommentaryRendersOnlyAnswerText(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", RequestID: request().RequestID, State: "thinking"}}}
	for _, id := range []string{"one", "two"} {
		raw, _ := json.Marshal(map[string]any{"threadId": "thread", "item": map[string]string{"id": id, "type": "agentMessage", "phase": "commentary", "text": `{"answer":"I will read the test note.","actions":[]}`}})
		a.notify("item/completed", raw)
	}
	got := a.snapshot("x")
	if len(got.Messages) != 1 || got.Messages[0].Text != "I will read the test note." {
		t.Fatalf("bad commentary: %+v", got.Messages)
	}
}

func TestConversationFailureSurvivesAccountStatusRefresh(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), status: "connected", conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking"}}}
	a.notify("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"status":"failed"}}`))
	if _, err := a.handle(context.Background(), Request{Operation: "status"}); err != nil {
		t.Fatal(err)
	}
	got := a.snapshot("x")
	if got.State != "error" || !strings.Contains(got.Reason, "could not finish") {
		t.Fatalf("account status hid failure: %+v", got)
	}
}

func TestRequestBoundary(t *testing.T) {
	r := request()
	if !validRequest(r) {
		t.Fatal("valid request refused")
	}
	for _, operation := range []string{"command/exec", "thread/read", "../../auth.json", "approve"} {
		bad := r
		bad.Operation = operation
		if validRequest(bad) {
			t.Fatalf("accepted %s", operation)
		}
	}
	r.PrincipalID = "../../another-user"
	if validRequest(r) {
		t.Fatal("path traversal accepted")
	}
	r = request()
	r.SharedText = strings.Repeat("a", 16001)
	if validRequest(r) {
		t.Fatal("oversize context accepted")
	}
}

func TestProtocolPersistenceAndDuplicateSend(t *testing.T) {
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	result, err := a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "thinking" || len(result.Messages) != 1 {
		t.Fatalf("bad initial state: %+v", result)
	}
	_, err = a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 2 {
		t.Fatalf("duplicate send started another turn: %v", f.calls)
	}
	start := f.params[0].(map[string]any)
	if start["sandbox"] != "read-only" || start["developerInstructions"] != r.Instructions {
		t.Fatal("sandbox or saved personality was not applied")
	}
	answer := `{"answer":"Here is a suggestion.","actions":[{"kind":"create_item","itemId":"","title":"Draft"}]}`
	message, _ := json.Marshal(map[string]any{"threadId": "provider-thread", "item": map[string]string{"type": "agentMessage", "text": answer}})
	a.notify("item/completed", message)
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))
	r.Operation = "read"
	result, err = a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "success" || len(result.Messages) != 2 || result.Messages[1].Actions[0].Title != "Draft" {
		t.Fatalf("bad final state: %+v", result)
	}
	if len(f.calls) != 2 {
		t.Fatal("an action executed without approval")
	}
	other := &account{home: a.home, conversations: map[string]*conversation{}}
	key := r.WorkspaceID + "-" + r.PetID
	if err = other.load(key); err != nil {
		t.Fatal(err)
	}
	if len(other.snapshot(key).Messages) != 2 {
		t.Fatal("conversation lost after restart")
	}
	info, err := os.Stat(filepath.Join(a.home, key+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("conversation is not private")
	}
}

func TestMalformedProviderMessageFailsClosed(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"session": {ThreadID: "thread", State: "thinking"}}}
	a.notify("item/completed", json.RawMessage(`{"threadId":"thread","item":{"type":"agentMessage","text":"not JSON"}}`))
	a.notify("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"status":"completed"}}`))
	if a.snapshot("session").State != "error" {
		t.Fatal("invalid response reported as successful")
	}
}

func TestIdentitiesAreSeparatedAndMalformedJSONRefused(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, t.TempDir(), "unused")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	var homes []string
	m.launch = func(_ context.Context, _ string, home string, _ func(string, json.RawMessage)) (Transport, error) {
		homes = append(homes, home)
		return &fakeTransport{}, nil
	}
	r := request()
	a, err := m.account(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	r.PrincipalID = "66666666-6666-4666-8666-666666666666"
	b, err := m.account(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if a == b || homes[0] == homes[1] {
		t.Fatal("users share provider state")
	}
	for _, body := range []string{`{}`, `{"tenantId":"../escape"}`, `{} {}`, strings.Repeat("x", 65<<10)} {
		w := httptest.NewRecorder()
		m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewBufferString(body)))
		if w.Code != 400 {
			t.Fatalf("bad input accepted: %d", w.Code)
		}
	}
}

func TestCodexHandshakeWithoutUserCredentials(t *testing.T) {
	binary := os.Getenv("NIX_TEST_CODEX_BINARY")
	if binary == "" {
		t.Skip("set NIX_TEST_CODEX_BINARY for the real, signed-out protocol smoke test")
	}
	transport, err := launch(context.Background(), binary, t.TempDir(), func(string, json.RawMessage) {})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	raw, err := transport.Call(context.Background(), "account/read", map[string]bool{"refreshToken": false})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Account json.RawMessage `json:"account"`
	}
	if json.Unmarshal(raw, &result) != nil || string(result.Account) != "null" {
		t.Fatal("isolated runtime inherited an account")
	}
	if _, err = transport.Call(context.Background(), "model/list", map[string]any{"limit": 100}); err != nil {
		t.Fatal(err)
	}
	// Thread creation validates the installed runtime's experimental tool schema without a model turn.
	if _, err = transport.Call(context.Background(), "thread/start", map[string]any{"dynamicTools": workspaceTools(), "sandbox": "read-only", "approvalPolicy": "on-request"}); err != nil {
		t.Fatal(err)
	}
}
