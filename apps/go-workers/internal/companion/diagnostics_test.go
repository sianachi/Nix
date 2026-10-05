package companion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	a.toolRequest(json.RawMessage(`3`), "item/tool/call", json.RawMessage(`{"threadId":"provider-thread","tool":"nix_search","callId":"c","arguments":{"query":"x","My diagnosis is SECRET-HEALTH":"red"}}`))
	events := logEvents(t, out.String())
	var reasons []string
	for _, event := range events {
		if event["msg"] == "companion tool.rejected" || event["msg"] == "companion tool.refused" {
			if reason, ok := event["reason"].(string); ok {
				reasons = append(reasons, reason)
			}
			if code, ok := event["reason_code"].(string); ok {
				reasons = append(reasons, code)
			}
		}
	}
	joined := strings.Join(reasons, " | ")
	for _, want := range []string{"workspace access is off", "not offered in this mode", "unknown_parameter"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing reason %q in %q", want, joined)
		}
	}
	if strings.Contains(out.String(), "SECRET") {
		t.Fatalf("an invented parameter name reached the shared log:\n%s", out.String())
	}
}

func TestArgumentRefusalCodesCoverEveryTemplate(t *testing.T) {
	cases := map[string]string{
		`"x" is not a parameter of nix_search; it accepts query.`: "unknown_parameter",
		"nix_search.query must be a string.":                      "not_string",
		"nix_add_view.spec must be a JSON object.":                "not_object",
		"nix_search requires a JSON object of arguments.":         "arguments_not_object",
		"nix_nope is not a supported tool.":                       "unsupported_tool",
		"nix_add_view.spec could not be processed.":               "unprocessable",
		"nix_add_view arguments could not be processed.":          "unprocessable",
	}
	for reason, want := range cases {
		if got := argumentRefusalCode(reason); got != want {
			t.Fatalf("argumentRefusalCode(%q) = %q, want %q", reason, got, want)
		}
	}
}

func TestFailedHistoryReadLogsNoIdentifiers(t *testing.T) {
	var out bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, Options{Root: t.TempDir(), Binary: "unused", Logger: slog.New(slog.NewJSONHandler(&out, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.launch = func(_ context.Context, _ string, home string, _ func(string, json.RawMessage)) (Transport, error) {
		if err := os.MkdirAll(home, 0700); err != nil {
			return nil, err
		}
		return &fakeTransport{}, nil
	}
	r := request()
	historyID := "66666666-6666-4666-8666-666666666666"
	body, _ := json.Marshal(Request{TenantID: r.TenantID, PrincipalID: r.PrincipalID, WorkspaceID: r.WorkspaceID, PetID: r.PetID, Operation: "read_history", HistoryID: historyID})
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status %d", w.Code)
	}
	failed := hasEvent(logEvents(t, out.String()), "companion request.failed")
	if failed == nil || failed["error"] != "open: no such file or directory" {
		t.Fatalf("request.failed: %v", failed)
	}
	for _, id := range []string{r.TenantID, r.PrincipalID, r.WorkspaceID, r.PetID, historyID} {
		if strings.Contains(out.String(), id) {
			t.Fatalf("shared log leaks id %q:\n%s", id, out.String())
		}
	}
}

func TestProviderFreeTextIsLoggedOnlyForNamedCodes(t *testing.T) {
	named := (&turnError{Message: "You have hit your usage limit", CodexErrorInfo: json.RawMessage(`"usageLimitExceeded"`)}).logAttrs()
	if !strings.Contains(fmt.Sprint(named), "You have hit your usage limit") {
		t.Fatalf("a named code should keep its message: %v", named)
	}
	details := "upstream body SECRET"
	http := (&turnError{Message: "SECRET upstream said no", CodexErrorInfo: json.RawMessage(`{"httpConnectionFailed":{"httpStatusCode":400}}`), AdditionalDetails: &details}).logAttrs()
	if strings.Contains(fmt.Sprint(http), "SECRET") || !strings.Contains(fmt.Sprint(http), "httpStatusCode") {
		t.Fatalf("an HTTP failure must log its code but not its free text: %v", http)
	}
}

func TestDeletingHistoryRemovesTheConversationTrace(t *testing.T) {
	_, home := diagnosticsTurn(t, true)
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	path := filepath.Join(home, "traces", conversationTag(key)+".jsonl")
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	a := &account{home: home, conversations: map[string]*conversation{}, trace: true}
	r.Operation = "delete_history"
	r.HistoryID = "66666666-6666-4666-8666-666666666666"
	if _, err := a.history(key, r); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("trace survived delete_history: %v", err)
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
	// An oversized log from an earlier launch is rotated rather than appended to forever.
	if err := os.MkdirAll(filepath.Join(home, "traces"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "traces", "codex-stderr.log"), bytes.Repeat([]byte("x"), maxStderrBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	// The fake provider is a script /bin/sh reads from the launch directory, never an executable
	// written and exec'd by this test: exec'ing a just-written file races other forks under load
	// (text file busy / an early exit that surfaces as a broken pipe on the first write).
	// launchWith runs "<binary> app-server ..." from <home>/empty, so "app-server" is the script.
	if err := os.MkdirAll(filepath.Join(home, "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "empty", "app-server"), []byte(`echo provider-diagnostic >&2
while IFS= read -r line; do
  case "$line" in
    *'"id":'*)
      id=${line#*\"id\":}
      id=${id%%[,\}]*}
      printf '{"id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
`), 0600); err != nil {
		t.Fatal(err)
	}
	transport, err := launchWith(context.Background(), "/bin/sh", home, func(string, json.RawMessage) {}, true)
	if err != nil {
		stderr, _ := os.ReadFile(filepath.Join(home, "traces", "codex-stderr.log"))
		t.Fatalf("%v; provider stderr: %q", err, stderr[max(0, len(stderr)-400):])
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
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 || info.Size() > maxStderrBytes {
		t.Fatalf("stderr log after rotation: %v %v", info, err)
	}
	if info, err := os.Stat(path + ".1"); err != nil || info.Size() <= maxStderrBytes {
		t.Fatalf("the oversized log was not rotated to .1: %v %v", info, err)
	}
}
