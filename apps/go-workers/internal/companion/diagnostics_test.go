package companion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// diagnosticsTurn drives one full turn - send, commentary, a tool call that is claimed and
// completed, a final answer, completion - through an account with the given trace setting, and
// returns the shared log output plus the account home.
func diagnosticsTurn(t *testing.T, trace bool) (string, string) {
	t.Helper()
	var out bytes.Buffer
	peer := &toolPeer{}
	home := t.TempDir()
	a := &account{transport: peer, home: home, conversations: map[string]*conversation{}, status: "connected", logger: slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})), trace: trace}
	r := request()
	r.Text = "SECRET-MESSAGE plan my week"
	r.WorkspaceAccess = true
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	a.notify("item/completed", json.RawMessage(`{"threadId":"provider-thread","item":{"id":"c1","type":"agentMessage","phase":"commentary","text":"SECRET-COMMENTARY creating a note"}}`))
	raw := json.RawMessage(`{"threadId":"provider-thread","tool":"nix_create_note","callId":"tool-1","arguments":{"title":"SECRET-TITLE","markdown":"SECRET-BODY"}}`)
	if !a.toolRequest(json.RawMessage(`7`), "item/tool/call", raw) {
		t.Fatal("valid tool request refused")
	}
	r.ToolID = "tool-1"
	r.Operation = "tool_claim"
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	r.Operation = "tool_result"
	r.ToolResult = "SECRET-RESULT created"
	r.ToolSuccess = true
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	a.notify("item/completed", json.RawMessage(`{"threadId":"provider-thread","item":{"id":"f1","type":"agentMessage","phase":"final_answer","text":"SECRET-ANSWER done"}}`))
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))
	return out.String(), home
}

func logEvents(t *testing.T, output string) []map[string]any {
	t.Helper()
	var events []map[string]any
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		var line map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatalf("log line is not JSON: %q", scanner.Text())
		}
		events = append(events, line)
	}
	return events
}

func hasEvent(events []map[string]any, message string) map[string]any {
	for _, event := range events {
		if event["msg"] == message {
			return event
		}
	}
	return nil
}

func TestSharedLogRecordsEveryStepButNoContent(t *testing.T) {
	output, home := diagnosticsTurn(t, false)
	events := logEvents(t, output)
	for _, name := range []string{"companion turn.started", "companion message", "companion tool.requested", "companion tool.claimed", "companion tool.result", "companion turn completed"} {
		if hasEvent(events, name) == nil {
			t.Fatalf("missing %q in shared log:\n%s", name, output)
		}
	}
	result := hasEvent(events, "companion tool.result")
	if result["tool"] != "create_note" || result["outcome"] != "ok" {
		t.Fatalf("tool.result fields: %v", result)
	}
	started := hasEvent(events, "companion turn.started")
	if started["thread"] != "new" || started["mode"] != "chat" || started["workspace_access"] != true {
		t.Fatalf("turn.started fields: %v", started)
	}
	if strings.Contains(output, "SECRET") {
		t.Fatalf("shared log leaks content:\n%s", output)
	}
	r := request()
	for _, id := range []string{r.WorkspaceID, r.PetID, r.PrincipalID, "provider-thread"} {
		if strings.Contains(output, id) {
			t.Fatalf("shared log leaks id %q", id)
		}
	}
	if _, err := os.Stat(filepath.Join(home, "traces")); !os.IsNotExist(err) {
		t.Fatal("a trace directory was written with tracing off")
	}
}

func TestTraceKeepsFullContentPrivately(t *testing.T) {
	output, home := diagnosticsTurn(t, true)
	if strings.Contains(output, "SECRET") {
		t.Fatalf("tracing must not put content in the shared log:\n%s", output)
	}
	r := request()
	path := filepath.Join(home, "traces", conversationTag(r.WorkspaceID+"-"+r.PetID)+".jsonl")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("trace file mode %v, want 0600", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"SECRET-MESSAGE", "SECRET-COMMENTARY", "SECRET-TITLE", "SECRET-BODY", "SECRET-RESULT", "SECRET-ANSWER"} {
		if !bytes.Contains(data, []byte(secret)) {
			t.Fatalf("trace is missing %q:\n%s", secret, data)
		}
	}
	events := logEvents(t, string(data))
	requested := map[string]any(nil)
	for _, event := range events {
		if event["event"] == "tool.requested" {
			requested = event
		}
	}
	content, _ := requested["content"].(map[string]any)
	flat, _ := content["flat"].(map[string]any)
	if flat["operation"] != "create_note" || flat["markdown"] != "SECRET-BODY" {
		t.Fatalf("trace should carry the flattened arguments: %v", requested)
	}
}

func TestRefusedAndRejectedToolCallsAreLoggedWithTheirReason(t *testing.T) {
	var out bytes.Buffer
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", logger: slog.New(slog.NewJSONHandler(&out, nil))}
	r := request()
	r.WorkspaceAccess = false
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"provider-thread","tool":"nix_search","callId":"a","arguments":{"query":"x"}}`))
	a.toolRequest(json.RawMessage(`2`), "item/tool/call", json.RawMessage(`{"threadId":"provider-thread","tool":"nix_validate_blueprint","callId":"b","arguments":{"blueprint":{}}}`))
	a.toolRequest(json.RawMessage(`3`), "item/tool/call", json.RawMessage(`{"threadId":"provider-thread","tool":"nix_search","callId":"c","arguments":{"query":"x","colour":"red"}}`))
	events := logEvents(t, out.String())
	var reasons []string
	for _, event := range events {
		if event["msg"] == "companion tool.rejected" || event["msg"] == "companion tool.refused" {
			reasons = append(reasons, event["reason"].(string))
		}
	}
	joined := strings.Join(reasons, " | ")
	for _, want := range []string{"workspace access is off", "not offered in this mode", "not a parameter of nix_search"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing reason %q in %q", want, joined)
		}
	}
}

func TestFailedTurnAndProviderErrorsCarryTheProviderCode(t *testing.T) {
	var out bytes.Buffer
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", logger: slog.New(slog.NewJSONHandler(&out, nil))}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	a.notify("error", json.RawMessage(`{"threadId":"provider-thread","turnId":"provider-turn","willRetry":true,"error":{"message":"stream disconnected","codexErrorInfo":"serverOverloaded"}}`))
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"failed","durationMs":1234,"error":{"message":"You have hit your usage limit","codexErrorInfo":"usageLimitExceeded"}}}`))
	events := logEvents(t, out.String())
	providerError := hasEvent(events, "companion provider.error")
	if providerError == nil || providerError["will_retry"] != true || !strings.Contains(providerError["code"].(string), "serverOverloaded") {
		t.Fatalf("provider.error: %v", providerError)
	}
	failed := hasEvent(events, "companion turn.failed")
	if failed == nil || failed["error"] != "You have hit your usage limit" || !strings.Contains(failed["code"].(string), "usageLimitExceeded") || failed["provider_duration_ms"] != float64(1234) {
		t.Fatalf("turn.failed: %v", failed)
	}
}

func TestRuntimeUnavailableIsLoggedWithTheCause(t *testing.T) {
	var out bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, Options{Root: t.TempDir(), Binary: "unused", Logger: slog.New(slog.NewJSONHandler(&out, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.launch = func(context.Context, string, string, func(string, json.RawMessage)) (Transport, error) {
		return nil, errors.New(`exec: "codex": executable file not found in $PATH`)
	}
	body, _ := json.Marshal(Request{TenantID: request().TenantID, PrincipalID: request().PrincipalID, Operation: "status"})
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.Code)
	}
	event := hasEvent(logEvents(t, out.String()), "companion runtime unavailable")
	if event == nil || !strings.Contains(event["error"].(string), "executable file not found") {
		t.Fatalf("missing runtime-unavailable cause: %s", out.String())
	}
}

func TestTraceCapturesProviderStderrPrivately(t *testing.T) {
	home := t.TempDir()
	script := filepath.Join(t.TempDir(), "fake-codex")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho provider-diagnostic >&2\nread line\nid=$(printf '%s' \"$line\" | sed -E 's/.*\"id\":(\"?[^\",}]*\"?).*/\\1/')\nprintf '{\"id\":%s,\"result\":{}}\\n' \"$id\"\nexec cat >/dev/null\n"), 0700); err != nil {
		t.Fatal(err)
	}
	transport, err := launchWith(context.Background(), script, home, func(string, json.RawMessage) {}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	path := filepath.Join(home, "traces", "codex-stderr.log")
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, _ := os.ReadFile(path)
		if bytes.Contains(data, []byte("provider-diagnostic")) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stderr not captured: %q", data)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("stderr log mode: %v %v", info, err)
	}
}
