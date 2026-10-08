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
	"reflect"
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
	if got := a.snapshot(key); len(got.Messages) != 2 || got.State != "thinking" {
		t.Fatalf("bad commentary: %+v", got)
	}
	if len(a.snapshot(key).Messages[1].ID) > 80 {
		t.Fatal("commentary ID exceeds client contract")
	}
	// toolVersion 5 forces every conversation onto a fresh thread, so a provider reply can
	// never carry the retired {"answer": ..., "actions": [...]} envelope any more; a final
	// answer that happens to be JSON-shaped text is stored exactly as written, never
	// unwrapped or parsed for actions.
	jsonShaped := `{"answer":"Created.","actions":[{"kind":"create_item","itemId":"","title":"Release"}]}`
	raw, err := json.Marshal(map[string]any{"threadId": "provider-thread", "item": map[string]string{"type": "agentMessage", "phase": "final_answer", "text": jsonShaped}})
	if err != nil {
		t.Fatal(err)
	}
	a.notify("item/completed", raw)
	final := a.snapshot(key).Messages[2]
	if final.Text != jsonShaped {
		t.Fatalf("final answer text was altered: %+v", final)
	}
	// The message wire shape has no actions member at all (D.2): one action path, tools.
	encoded, err := json.Marshal(final)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"actions"`) {
		t.Fatalf("a message still carries an actions member: %s", encoded)
	}
	if a.snapshot(key).State == "error" {
		t.Fatal("a JSON-shaped answer failed the turn")
	}
}

// TestCommentaryTextIsUsedAsIs proves commentary text is stored exactly as the provider sent
// it, with no {"answer": ...} envelope unwrap: a JSON-shaped commentary is kept as JSON text,
// matching the final-answer path removing the same legacy unwrap.
func TestCommentaryTextIsUsedAsIs(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", RequestID: request().RequestID, State: "thinking"}}}
	jsonShaped := `{"answer":"I will read the test note.","actions":[]}`
	for _, id := range []string{"one", "two"} {
		raw, _ := json.Marshal(map[string]any{"threadId": "thread", "item": map[string]string{"id": id, "type": "agentMessage", "phase": "commentary", "text": jsonShaped}})
		a.notify("item/completed", raw)
	}
	got := a.snapshot("x")
	if len(got.Messages) != 1 || got.Messages[0].Text != jsonShaped {
		t.Fatalf("commentary text was altered: %+v", got.Messages)
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
	answer := "Here is a suggestion."
	message, _ := json.Marshal(map[string]any{"threadId": "provider-thread", "item": map[string]string{"type": "agentMessage", "text": answer}})
	a.notify("item/completed", message)
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))
	r.Operation = "read"
	result, err = a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "success" || len(result.Messages) != 2 || result.Messages[1].Text != "Here is a suggestion." {
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

// TestPlainTextFinalAnswerIsStoredAsIs proves L2.2: the final agent message is plain text
// now that outputSchema is gone, so text that is not JSON at all is stored verbatim and the
// turn still succeeds, rather than failing the turn the way a non-JSON answer once did.
func TestPlainTextFinalAnswerIsStoredAsIs(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"session": {ThreadID: "thread", RequestID: "req", State: "thinking"}}}
	a.notify("item/completed", json.RawMessage(`{"threadId":"thread","item":{"type":"agentMessage","text":"not JSON"}}`))
	a.notify("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"status":"completed"}}`))
	got := a.snapshot("session")
	if got.State != "success" {
		t.Fatalf("plain text answer failed the turn: %+v", got)
	}
	if len(got.Messages) != 1 || got.Messages[0].Text != "not JSON" {
		t.Fatalf("plain text answer not stored as-is: %+v", got.Messages)
	}
}

// TestOversizeFinalAnswerIsTruncatedNotErrored proves L2.2: an answer over the 32000-byte
// cap is truncated on a UTF-8 boundary rather than failing the turn.
func TestOversizeFinalAnswerIsTruncatedNotErrored(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"session": {ThreadID: "thread", RequestID: "req", State: "thinking"}}}
	message, _ := json.Marshal(map[string]any{"threadId": "thread", "item": map[string]string{"type": "agentMessage", "text": strings.Repeat("a", 32200)}})
	a.notify("item/completed", message)
	a.notify("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"status":"completed"}}`))
	got := a.snapshot("session")
	if got.State != "success" {
		t.Fatalf("oversize answer failed the turn: %+v", got)
	}
	if len(got.Messages) != 1 || len(got.Messages[0].Text) != 32000 {
		t.Fatalf("oversize answer not truncated to 32000 bytes: %d", len(got.Messages[0].Text))
	}
}

func TestIdentitiesAreSeparatedAndMalformedJSONRefused(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, Options{Root: t.TempDir(), Binary: "unused", ChatEffort: "low"})
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
	// Thread creation validates both modes' tool schemas without a model turn.
	for _, mode := range []string{"chat", "consult"} {
		if _, err = transport.Call(context.Background(), "thread/start", map[string]any{"dynamicTools": workspaceTools(mode), "sandbox": "read-only", "approvalPolicy": "on-request"}); err != nil {
			t.Fatalf("%s tool schema: %v", mode, err)
		}
	}
}

func TestToolVersionChangeStartsFreshThreadAndKeepsMessages(t *testing.T) {
	r := request()
	key := r.WorkspaceID + "-" + r.PetID

	// A first-ever conversation (ToolVersion 0, no thread yet) starts fresh and gets no notice.
	first := &fakeTransport{}
	a := &account{transport: first, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
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
	b.conversations[key] = &conversation{ToolVersion: toolVersion + 1, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
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
	c.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "current-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
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
	d.conversations[key] = &conversation{ThreadID: "legacy-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
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

// The Phase D tool version bump (consult mode, validate_blueprint, build_blueprint,
// save_as_template) must restart any thread that still carries the old schema.
// TestToolVersionChangeStartsFreshThreadAndKeepsMessages proves the mechanism generically,
// relative to toolVersion; this pins the constant itself to 5 (L1: nix_workspace's single
// flat-argument tool replaced by one typed nix_<operation> tool per operation), so a future bump
// that forgets to change it would not silently pass either test.
func TestToolVersionFiveRestartsThreads(t *testing.T) {
	if toolVersion != 5 {
		t.Fatalf("L1 expects toolVersion 5, got %d", toolVersion)
	}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{ToolVersion: 4, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if f.calls[0] != "thread/start" {
		t.Fatalf("a ToolVersion 4 conversation should start a fresh thread on the version 5 bump: %v", f.calls)
	}
	got := a.snapshot(key)
	if len(got.Messages) != 3 || got.Messages[1].Role != "system" {
		t.Fatalf("no system notice appended on the version 5 bump: %+v", got.Messages)
	}
	if a.conversations[key].ToolVersion != 5 {
		t.Fatalf("conversation not recorded at tool version 5: %d", a.conversations[key].ToolVersion)
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
	a.conversations[key] = &conversation{ToolVersion: toolVersion + 1, ThreadID: "old-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}

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

// TestConsultUsesItsOwnConversationKeyAndToolSet proves chat and consult are two separate
// conversations for the same pet, each starting its own provider thread with its own
// dynamicTools, per pet-structure-consult-architecture.md section 6.
func TestConsultUsesItsOwnConversationKeyAndToolSet(t *testing.T) {
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	consultRequest := r
	consultRequest.Mode = "consult"
	consultRequest.RequestID = "66666666-6666-4666-8666-666666666666"
	if _, err := a.handle(context.Background(), consultRequest); err != nil {
		t.Fatal(err)
	}

	chatKey := r.WorkspaceID + "-" + r.PetID
	consultKey := chatKey + "-consult"
	if len(a.conversations) != 2 {
		t.Fatalf("expected two conversations, got %d", len(a.conversations))
	}
	if _, ok := a.conversations[chatKey]; !ok {
		t.Fatal("chat conversation missing")
	}
	if _, ok := a.conversations[consultKey]; !ok {
		t.Fatal("consult conversation missing")
	}

	starts := 0
	var chatParams, consultParams map[string]any
	for i, call := range f.calls {
		if call != "thread/start" {
			continue
		}
		starts++
		if starts == 1 {
			chatParams, _ = f.params[i].(map[string]any)
		} else {
			consultParams, _ = f.params[i].(map[string]any)
		}
	}
	if starts != 2 {
		t.Fatalf("expected two thread starts, got %d: %v", starts, f.calls)
	}
	chatTools, _ := chatParams["dynamicTools"].([]any)
	consultTools, _ := consultParams["dynamicTools"].([]any)
	if len(chatTools) == 0 || len(consultTools) == 0 {
		t.Fatal("dynamicTools missing from a thread start")
	}
	if reflect.DeepEqual(chatTools, consultTools) {
		t.Fatal("chat and consult received the same tool set")
	}
}

// TestConsultModelPreferenceFallsBackToProviderDefault covers owner decision 4
// (pet-structure-consult-plan.md section 1.4): an unset model in consult mode picks the
// first NIX_COMPANION_CONSULT_MODELS entry the provider actually offers, and leaves the
// model unset (provider default) when none of them are offered.
func TestConsultModelPreferenceFallsBackToProviderDefault(t *testing.T) {
	defaultProvider := &fakeTransport{}
	defaultAccount := &account{transport: defaultProvider, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	defaultRequest := request()
	defaultRequest.Mode = "consult"
	if _, err := defaultAccount.handle(context.Background(), defaultRequest); err != nil {
		t.Fatal(err)
	}
	defaultStart := startParams(t, defaultProvider)
	if _, ok := defaultStart["model"]; ok {
		t.Fatalf("empty preference must use the provider default: %+v", defaultStart)
	}
	for _, call := range defaultProvider.calls {
		if call == "model/list" {
			t.Fatal("provider default must not require a model list request")
		}
	}

	preferred := &modelListTransport{models: []string{"gpt-5"}}
	a := &account{transport: preferred, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", consultModels: []string{"gpt-5-mini", "gpt-5"}}
	r := request()
	r.Mode = "consult"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	start := startParams(t, &preferred.fakeTransport)
	if start["model"] != "gpt-5" {
		t.Fatalf("expected the first available preferred model, got %+v", start)
	}

	none := &modelListTransport{models: []string{"other-model"}}
	b := &account{transport: none, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", consultModels: []string{"gpt-5-mini", "gpt-5"}}
	r2 := request()
	r2.Mode = "consult"
	if _, err := b.handle(context.Background(), r2); err != nil {
		t.Fatal(err)
	}
	start2 := startParams(t, &none.fakeTransport)
	if _, ok := start2["model"]; ok {
		t.Fatalf("no preferred model available should leave the provider default: %+v", start2)
	}
}

// modelListTransport answers model/list with a fixed set of model ids, so consult model
// preference can be tested without a real Codex process.
type modelListTransport struct {
	fakeTransport
	models []string
}

func (m *modelListTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method != "model/list" {
		return m.fakeTransport.Call(ctx, method, params)
	}
	m.mu.Lock()
	m.calls = append(m.calls, method)
	m.params = append(m.params, params)
	m.mu.Unlock()
	data := make([]map[string]any, 0, len(m.models))
	for _, id := range m.models {
		data = append(data, map[string]any{"model": id, "displayName": id, "isDefault": false})
	}
	raw, err := json.Marshal(map[string]any{"data": data})
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func startParams(t *testing.T, f *fakeTransport) map[string]any {
	t.Helper()
	for i, call := range f.calls {
		if call == "thread/start" {
			start, ok := f.params[i].(map[string]any)
			if !ok {
				t.Fatalf("thread/start params: %T", f.params[i])
			}
			return start
		}
	}
	t.Fatal("thread/start not called")
	return nil
}

// turnStartParams is startParams' counterpart for turn/start, used by the effort tests below.
func turnStartParams(t *testing.T, f *fakeTransport) map[string]any {
	t.Helper()
	for i, call := range f.calls {
		if call == "turn/start" {
			params, ok := f.params[i].(map[string]any)
			if !ok {
				t.Fatalf("turn/start params: %T", f.params[i])
			}
			return params
		}
	}
	t.Fatal("turn/start not called")
	return nil
}

// modelListEffortTransport answers model/list with one model advertising the given supported
// reasoning efforts (and marks it default), so effortFor can be tested without a real Codex
// process.
type modelListEffortTransport struct {
	fakeTransport
	modelID          string
	supportedEfforts []string
}

func (m *modelListEffortTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method != "model/list" {
		return m.fakeTransport.Call(ctx, method, params)
	}
	m.mu.Lock()
	m.calls = append(m.calls, method)
	m.params = append(m.params, params)
	m.mu.Unlock()
	efforts := make([]map[string]any, 0, len(m.supportedEfforts))
	for _, effort := range m.supportedEfforts {
		efforts = append(efforts, map[string]any{"reasoningEffort": effort})
	}
	raw, err := json.Marshal(map[string]any{"data": []map[string]any{{
		"model": m.modelID, "displayName": m.modelID, "isDefault": true,
		"supportedReasoningEfforts": efforts, "defaultReasoningEffort": "low",
	}}})
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// TestEffortIsSentOnlyWhenTheEffectiveModelAdvertisesIt covers config.go's
// NIX_COMPANION_CHAT_EFFORT / NIX_COMPANION_CONSULT_EFFORT plumbed through to effortFor: a
// configured value reaches turn/start only when the effective model (the request's explicit
// model, else whichever model/list marks default) actually advertises it; otherwise turn/start
// omits "effort" rather than failing the turn.
func TestEffortIsSentOnlyWhenTheEffectiveModelAdvertisesIt(t *testing.T) {
	t.Run("chat effort sent when the default model supports it", func(t *testing.T) {
		f := &modelListEffortTransport{modelID: "gpt-5", supportedEfforts: []string{"low", "medium"}}
		a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", chatEffort: "low"}
		if _, err := a.handle(context.Background(), request()); err != nil {
			t.Fatal(err)
		}
		if got := turnStartParams(t, &f.fakeTransport)["effort"]; got != "low" {
			t.Fatalf("effort = %v, want \"low\"", got)
		}
	})

	t.Run("effort omitted when the default model does not support it", func(t *testing.T) {
		f := &modelListEffortTransport{modelID: "gpt-5", supportedEfforts: []string{"medium", "high"}}
		a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", chatEffort: "low"}
		if _, err := a.handle(context.Background(), request()); err != nil {
			t.Fatal(err)
		}
		if _, ok := turnStartParams(t, &f.fakeTransport)["effort"]; ok {
			t.Fatal("effort sent for a model that does not advertise it")
		}
	})

	t.Run("effort omitted when unconfigured", func(t *testing.T) {
		f := &modelListEffortTransport{modelID: "gpt-5", supportedEfforts: []string{"low"}}
		a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
		if _, err := a.handle(context.Background(), request()); err != nil {
			t.Fatal(err)
		}
		if _, ok := turnStartParams(t, &f.fakeTransport)["effort"]; ok {
			t.Fatal("effort sent with no configured value")
		}
		for _, call := range f.calls {
			if call == "model/list" {
				t.Fatal("model/list requested with no configured effort")
			}
		}
	})

	t.Run("consult effort follows the consult setting, not the chat one", func(t *testing.T) {
		f := &modelListEffortTransport{modelID: "gpt-5", supportedEfforts: []string{"high"}}
		a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", chatEffort: "low", consultEffort: "high"}
		r := request()
		r.Mode = "consult"
		if _, err := a.handle(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		if got := turnStartParams(t, &f.fakeTransport)["effort"]; got != "high" {
			t.Fatalf("effort = %v, want \"high\"", got)
		}
	})

	t.Run("effort omitted when the model list call fails", func(t *testing.T) {
		f := &failingModelListTransport{}
		a := &account{transport: f, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", chatEffort: "low"}
		if _, err := a.handle(context.Background(), request()); err != nil {
			t.Fatal(err)
		}
		if _, ok := turnStartParams(t, &f.fakeTransport)["effort"]; ok {
			t.Fatal("effort sent despite a failed model list call")
		}
	})
}

// failingModelListTransport refuses model/list only, so effortFor's failure path (omit effort,
// never fail the turn) can be exercised without a real Codex process.
type failingModelListTransport struct {
	fakeTransport
}

func (f *failingModelListTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method == "model/list" {
		f.mu.Lock()
		f.calls = append(f.calls, method)
		f.params = append(f.params, params)
		f.mu.Unlock()
		return nil, errors.New("model list unavailable")
	}
	return f.fakeTransport.Call(ctx, method, params)
}

// TestInvalidModeIsRefused covers owner decision 4's neighbour, validRequest's mode gate:
// only the empty string, "chat" and "consult" are accepted.
func TestInvalidModeIsRefused(t *testing.T) {
	r := request()
	r.Mode = "supervisor"
	if validRequest(r) {
		t.Fatal("invalid mode accepted")
	}
	for _, mode := range []string{"", "chat", "consult"} {
		valid := r
		valid.Mode = mode
		if !validRequest(valid) {
			t.Fatalf("valid mode %q refused", mode)
		}
	}
}

func TestModeJSONContractAllowsStatusAndConnect(t *testing.T) {
	for _, operation := range []string{"status", "connect"} {
		raw, err := json.Marshal(map[string]string{
			"tenantId":    request().TenantID,
			"principalId": request().PrincipalID,
			"operation":   operation,
			"mode":        "consult",
		})
		if err != nil {
			t.Fatal(err)
		}
		var got Request
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		if got.Mode != "consult" || !validRequest(got) {
			t.Fatalf("%s request did not retain consult mode", operation)
		}
		a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "disconnected"}
		if _, err := a.handle(context.Background(), got); err != nil {
			t.Fatalf("%s request failed: %v", operation, err)
		}
	}
}

// TestResetInOneModeKeepsTheOther proves the mode-scoped conversation key means a chat
// reset cannot wipe the consult conversation for the same pet, and vice versa.
func TestResetInOneModeKeepsTheOther(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.Operation = "read"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	chatKey := r.WorkspaceID + "-" + r.PetID
	a.conversations[chatKey].Messages = []Message{{ID: "one", Role: "user", Text: "Chat message"}}

	consultRead := r
	consultRead.Mode = "consult"
	if _, err := a.handle(context.Background(), consultRead); err != nil {
		t.Fatal(err)
	}
	consultKey := chatKey + "-consult"
	a.conversations[consultKey].Messages = []Message{{ID: "two", Role: "user", Text: "Consult message"}}

	reset := r
	reset.Operation = "reset"
	if _, err := a.handle(context.Background(), reset); err != nil {
		t.Fatal(err)
	}
	if len(a.snapshot(chatKey).Messages) != 0 {
		t.Fatal("chat conversation was not reset")
	}
	if len(a.snapshot(consultKey).Messages) != 1 {
		t.Fatal("consult conversation was wiped by a chat reset")
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

// promptOf decodes the JSON user turn the model received on turn/start.
func promptOf(t *testing.T, f *fakeTransport) map[string]any {
	t.Helper()
	params := turnStartParams(t, f)
	input, _ := params["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("turn/start input: %+v", params["input"])
	}
	entry, _ := input[0].(map[string]any)
	text, _ := entry["text"].(string)
	var prompt map[string]any
	if err := json.Unmarshal([]byte(text), &prompt); err != nil {
		t.Fatalf("prompt is not JSON: %v", err)
	}
	return prompt
}

// TestTurnPromptCarriesDateZoneAndFirstTurnMap pins B.1 and B.2: today and timeZone reach the
// model on every turn, and workspaceMap only on the turn that starts a new thread - a resumed
// thread already holds it, so a map sent again is left out.
func TestTurnPromptCarriesDateZoneAndFirstTurnMap(t *testing.T) {
	r := request()
	r.Today = "2026-10-09"
	r.TimeZone = "Europe/London"
	r.WorkspaceMap = []WorkspaceMapEntry{
		{ID: "66666666-6666-4666-8666-666666666666", Title: "Tasks", Type: "note", ViewKinds: []string{"board", "calendar"}},
		{ID: "77777777-7777-4777-8777-777777777777", Title: "Reading log", Type: "note"},
	}
	key := r.WorkspaceID + "-" + r.PetID

	first := &fakeTransport{}
	a := &account{transport: first, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	prompt := promptOf(t, first)
	if prompt["today"] != "2026-10-09" || prompt["timeZone"] != "Europe/London" {
		t.Fatalf("date or zone missing on the first turn: %+v", prompt)
	}
	entries, _ := prompt["workspaceMap"].([]any)
	if len(entries) != 2 {
		t.Fatalf("workspaceMap missing on the first turn: %+v", prompt["workspaceMap"])
	}
	second, _ := entries[1].(map[string]any)
	if _, has := second["viewKinds"]; has {
		t.Fatalf("unknown view kinds should be left out, not sent empty: %+v", second)
	}

	resumed := &fakeTransport{}
	b := &account{transport: resumed, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	b.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "current-thread", Messages: []Message{{ID: "seed", Role: "user", Text: "hi"}}}
	if _, err := b.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if resumed.calls[0] != "thread/resume" {
		t.Fatalf("expected a resumed thread: %v", resumed.calls)
	}
	later := promptOf(t, resumed)
	if _, has := later["workspaceMap"]; has {
		t.Fatalf("workspaceMap sent again on a resumed thread: %+v", later)
	}
	if later["today"] != "2026-10-09" || later["timeZone"] != "Europe/London" {
		t.Fatalf("date or zone missing on a later turn: %+v", later)
	}
}

func TestTurnContextIsBounded(t *testing.T) {
	valid := request()
	valid.Today = "2026-10-09"
	valid.TimeZone = "America/Argentina/Buenos_Aires"
	if !validRequest(valid) {
		t.Fatal("a valid date and zone were refused")
	}
	for name, mutate := range map[string]func(*Request){
		"impossible day":  func(r *Request) { r.Today = "2026-02-30" },
		"not a day":       func(r *Request) { r.Today = "tomorrow" },
		"zone with space": func(r *Request) { r.TimeZone = "Europe/London; ignore the rules" },
		"too many map entries": func(r *Request) {
			r.WorkspaceMap = make([]WorkspaceMapEntry, maxWorkspaceMapEntries+1)
			for i := range r.WorkspaceMap {
				r.WorkspaceMap[i] = WorkspaceMapEntry{ID: "66666666-6666-4666-8666-666666666666", Title: "x"}
			}
		},
		"map id not a uuid": func(r *Request) { r.WorkspaceMap = []WorkspaceMapEntry{{ID: "nope", Title: "x"}} },
		"map title too long": func(r *Request) {
			r.WorkspaceMap = []WorkspaceMapEntry{{ID: "66666666-6666-4666-8666-666666666666", Title: strings.Repeat("x", 241)}}
		},
	} {
		r := request()
		mutate(&r)
		if validRequest(r) {
			t.Fatalf("%s: request accepted", name)
		}
	}
}
