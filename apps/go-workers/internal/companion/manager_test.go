package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

func TestPreActionCommentaryIsVisibleOnceAndAnswerActionsAreIgnored(t *testing.T) {
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
	// The output schema no longer asks for "actions", but a model that returns one
	// anyway must still be accepted as plain text, not fail the turn.
	a.notify("item/completed", json.RawMessage(`{"threadId":"provider-thread","item":{"type":"agentMessage","phase":"final_answer","text":"{\"answer\":\"Created.\",\"actions\":[{\"kind\":\"create_item\",\"itemId\":\"\",\"title\":\"Release\"}]}"}}`))
	final := a.snapshot(key).Messages[2]
	if final.Text != "Created." {
		t.Fatalf("answer text lost: %+v", final)
	}
	if len(final.Actions) != 0 {
		t.Fatal("legacy actions were rendered")
	}
	if a.snapshot(key).State == "error" {
		t.Fatal("an extra actions field failed the turn")
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
	if result.State != "success" || len(result.Messages) != 2 || len(result.Messages[1].Actions) != 0 || result.Messages[1].Text != "Here is a suggestion." {
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

func TestToolVersionChangeStartsFreshThreadAndKeepsMessages(t *testing.T) {
	r := request()
	key := r.WorkspaceID + "-" + r.PetID

	// A first-ever conversation (ToolVersion 0, no thread yet) starts fresh and gets no notice.
	first := &fakeTransport{}
	a := &account{transport: first, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if first.calls[0] != "thread/start" {
		t.Fatalf("first-ever conversation should start fresh: %v", first.calls)
	}
	for _, m := range a.snapshot(key).Messages {
		if m.Role == "system" {
			t.Fatal("first-ever conversation got a system notice")
		}
	}

	// A conversation already at a stale, non-zero tool version starts fresh, keeps its
	// messages, and gets the system notice, with an ID the client can render.
	stale := &fakeTransport{}
	b := &account{transport: stale, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	b.conversations[key] = &conversation{ToolVersion: toolVersion + 1, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}
	if _, err := b.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if stale.calls[0] != "thread/start" {
		t.Fatalf("stale-version send should start a fresh thread, not resume: %v", stale.calls)
	}
	if start, ok := stale.params[0].(map[string]any); !ok || start["dynamicTools"] == nil {
		t.Fatalf("fresh thread did not register the tool schema: %+v", stale.params[0])
	}
	got := b.snapshot(key)
	if len(got.Messages) != 3 || got.Messages[0].Text != "hi" || got.Messages[1].Role != "system" || got.Messages[2].ID != r.RequestID {
		t.Fatalf("messages out of order on version bump: %+v", got.Messages)
	}
	if !strings.Contains(got.Messages[1].Text, "fresh conversation") {
		t.Fatalf("no system notice appended on version bump: %+v", got.Messages[1])
	}
	if len(got.Messages[1].ID) > 80 {
		t.Fatal("notice ID exceeds client contract")
	}

	// A conversation already at the current tool version resumes its thread.
	current := &fakeTransport{}
	c := &account{transport: current, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	c.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "current-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}
	if _, err := c.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if current.calls[0] != "thread/resume" {
		t.Fatalf("matching tool version should resume: %v", current.calls)
	}

	// A version-0 conversation that already has a thread (predates tool versioning) starts
	// fresh silently, like the very first case: version 0 is never treated as "stale", only
	// as "not yet versioned".
	legacy := &fakeTransport{}
	d := &account{transport: legacy, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	d.conversations[key] = &conversation{ThreadID: "legacy-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}
	if _, err := d.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if legacy.calls[0] != "thread/start" {
		t.Fatalf("version-0 conversation should start fresh: %v", legacy.calls)
	}
	for _, m := range d.snapshot(key).Messages {
		if m.Role == "system" {
			t.Fatal("version-0 conversation got a system notice")
		}
	}
}

// The Phase B tool version bump (add_fields, edit_form, set_recurrence) must restart any
// thread that still carries the old schema. TestToolVersionChangeStartsFreshThreadAndKeepsMessages
// proves the mechanism generically, relative to toolVersion; this pins the constant itself
// to 3, so a future bump that forgets to change it would not silently pass either test.
func TestToolVersionThreeRestartsThreads(t *testing.T) {
	if toolVersion != 3 {
		t.Fatalf("Phase B expects toolVersion 3, got %d", toolVersion)
	}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{ToolVersion: 2, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if f.calls[0] != "thread/start" {
		t.Fatalf("a ToolVersion 2 conversation should start a fresh thread on the version 3 bump: %v", f.calls)
	}
	got := a.snapshot(key)
	if len(got.Messages) != 3 || got.Messages[1].Role != "system" {
		t.Fatalf("no system notice appended on the version 3 bump: %+v", got.Messages)
	}
	if a.conversations[key].ToolVersion != 3 {
		t.Fatalf("conversation not recorded at tool version 3: %d", a.conversations[key].ToolVersion)
	}
}

// A failed send must not leave a notice behind that a retry then duplicates: the
// commit that appends it and the commit that clears the stale version happen in the
// same locked section, so only the attempt that actually starts a fresh thread appends it.
func TestFailedSendNeverDuplicatesTheVersionNotice(t *testing.T) {
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	f := &flakyTransport{failFirstThreadStart: true}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{ToolVersion: toolVersion + 1, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}}

	if _, err := a.handle(context.Background(), r); err == nil {
		t.Fatal("expected the first attempt to fail")
	}
	for _, m := range a.snapshot(key).Messages {
		if m.Role == "system" {
			t.Fatal("a failed send appended the notice before the thread actually restarted")
		}
	}

	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	notices := 0
	for _, m := range a.snapshot(key).Messages {
		if m.Role == "system" {
			notices++
		}
	}
	if notices != 1 {
		t.Fatalf("retry after a failed send produced %d notices, want 1", notices)
	}
}

type flakyTransport struct {
	fakeTransport
	failFirstThreadStart bool
}

func (f *flakyTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method == "thread/start" && f.failFirstThreadStart {
		f.failFirstThreadStart = false
		f.mu.Lock()
		f.calls = append(f.calls, method)
		f.params = append(f.params, params)
		f.mu.Unlock()
		return nil, errors.New("transport unavailable")
	}
	return f.fakeTransport.Call(ctx, method, params)
}
