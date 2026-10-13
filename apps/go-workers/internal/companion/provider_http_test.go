package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// sseServer answers one streaming request with the given SSE frames and records the request body.
func sseServer(t *testing.T, status int, frames []string, onRequest func(*http.Request, []byte)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if onRequest != nil {
			onRequest(r, body)
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, frame := range frames {
			_, _ = fmt.Fprint(w, frame)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	}))
}

type notifications struct {
	mu     sync.Mutex
	events []string
	done   chan struct{}
}

func newNotifications() *notifications {
	return &notifications{done: make(chan struct{}, 4)}
}

func (n *notifications) notify(method string, raw json.RawMessage) {
	n.mu.Lock()
	n.events = append(n.events, method+" "+string(raw))
	n.mu.Unlock()
	if method == "turn/completed" {
		n.done <- struct{}{}
	}
}

func (n *notifications) wait(t *testing.T) []string {
	t.Helper()
	select {
	case <-n.done:
	case <-time.After(5 * time.Second):
		t.Fatal("turn never completed")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string{}, n.events...)
}

func startThreadAndTurn(t *testing.T, transport Transport, tools []any, text string) (thread string, turn string) {
	t.Helper()
	params := map[string]any{"model": "test-model", "baseInstructions": "base", "developerInstructions": "dev"}
	if tools != nil {
		params["dynamicTools"] = tools
	}
	raw, err := transport.Call(context.Background(), "thread/start", params)
	if err != nil {
		t.Fatal(err)
	}
	var started struct {
		Thread struct{ ID string } `json:"thread"`
	}
	_ = json.Unmarshal(raw, &started)
	raw, err = transport.Call(context.Background(), "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": text}}})
	if err != nil {
		t.Fatal(err)
	}
	var turned struct {
		Turn struct{ ID string } `json:"turn"`
	}
	_ = json.Unmarshal(raw, &turned)
	return started.Thread.ID, turned.Turn.ID
}

func TestAnthropicStreamsTextIntoCodexShapedNotifications(t *testing.T) {
	var seen []byte
	server := sseServer(t, http.StatusOK, []string{
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	}, func(r *http.Request, body []byte) {
		seen = body
		if r.Header.Get("x-api-key") != "sk-ant-test" {
			t.Errorf("missing api key header")
		}
	})
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	thread, _ := startThreadAndTurn(t, transport, nil, "Hi")
	events := n.wait(t)
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `item/agentMessage/delta {"delta":"Hello"`) || !strings.Contains(joined, `"text":"Hello there"`) || !strings.Contains(joined, `"status":"completed"`) {
		t.Fatalf("unexpected notifications:\n%s", joined)
	}
	if !strings.Contains(joined, thread) {
		t.Fatalf("notifications must name the thread: %s", joined)
	}
	if !strings.Contains(string(seen), `"system":"base\n\ndev"`) || !strings.Contains(string(seen), `"content":"Hi"`) {
		t.Fatalf("request body missing system or user message: %s", seen)
	}
}

func TestAnthropicToolCallRoundTripsThroughTheHandlerAndReply(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 {
			_, _ = fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"nix_read_note\"}}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"itemId\\\":\\\"abc\\\"}\"}}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
			return
		}
		// The second request must carry the tool result the handler replied with.
		if !strings.Contains(string(body), `"tool_result"`) || !strings.Contains(string(body), `Note says hello`) {
			t.Errorf("second request lacks the tool result: %s", body)
		}
		_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\n")
	}))
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	peer := transport.(toolTransport)
	var handled []string
	peer.SetRequestHandler(func(id json.RawMessage, method string, params json.RawMessage) bool {
		handled = append(handled, method+" "+string(params))
		go func() { _ = peer.Reply(id, toolOutput(true, "Note says hello")) }()
		return true
	})
	tools := []any{map[string]any{"name": "nix_read_note", "description": "read", "inputSchema": map[string]any{"type": "object"}}}
	startThreadAndTurn(t, transport, tools, "Read it")
	events := n.wait(t)
	if len(handled) != 1 || !strings.Contains(handled[0], `"tool":"nix_read_note"`) || !strings.Contains(handled[0], `"callId":"call-1"`) {
		t.Fatalf("handler saw %v", handled)
	}
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `"text":"Done"`) || !strings.Contains(joined, `"status":"completed"`) {
		t.Fatalf("unexpected notifications:\n%s", joined)
	}
	if calls != 2 {
		t.Fatalf("expected two provider requests, got %d", calls)
	}
}

func TestARefusedToolBecomesAnErrorResultNotAHang(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 {
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"nix_trash\",\"arguments\":\"{}\"}}]}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		if !strings.Contains(string(body), `"role":"tool"`) || !strings.Contains(string(body), "not available") {
			t.Errorf("refusal not fed back: %s", body)
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "openrouter", server.URL, n.notify)
	transport.(toolTransport).SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool { return false })
	tools := []any{map[string]any{"name": "nix_trash", "description": "t", "inputSchema": map[string]any{"type": "object"}}}
	thread, _ := startThreadAndTurn(t, transport, tools, "Trash it")
	_ = thread
	events := n.wait(t)
	if !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
		t.Fatalf("turn did not complete: %v", events)
	}
}

func TestInterruptEndsTheTurnAsInterrupted(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	n := newNotifications()
	transport := testTransport(t, "anthropic", server.URL, n.notify)
	_, turn := startThreadAndTurn(t, transport, nil, "Wait")
	time.Sleep(50 * time.Millisecond)
	if _, err := transport.Call(context.Background(), "turn/interrupt", map[string]string{"turnId": turn}); err != nil {
		t.Fatal(err)
	}
	events := n.wait(t)
	if !strings.Contains(strings.Join(events, "\n"), `"status":"interrupted"`) {
		t.Fatalf("expected interrupted: %v", events)
	}
}

func TestARejectedKeyFailsTheTurnWithAnActionableReason(t *testing.T) {
	server := sseServer(t, http.StatusUnauthorized, nil, nil)
	defer server.Close()
	n := newNotifications()
	transport := testTransport(t, "openrouter", server.URL, n.notify)
	startThreadAndTurn(t, transport, nil, "Hi")
	events := n.wait(t)
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, `"status":"failed"`) || !strings.Contains(joined, "rejected the API key") {
		t.Fatalf("expected a key rejection: %s", joined)
	}
	if strings.Contains(joined, "sk-or-test") {
		t.Fatal("the key leaked into a notification")
	}
}

func TestOpenRouterModelListMarksToolSupport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-or-test" {
			t.Errorf("missing bearer")
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"a/tools","name":"Tools","supported_parameters":["tools","temperature"]},{"id":"b/plain","name":"Plain","supported_parameters":["temperature"]}]}`))
	}))
	defer server.Close()
	transport := testTransport(t, "openrouter", server.URL, func(string, json.RawMessage) {})
	raw, err := transport.Call(context.Background(), "model/list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"model":"a/tools"`) || !strings.Contains(string(raw), `"supportsTools":false`) {
		t.Fatalf("unexpected list: %s", raw)
	}
	a := &account{transport: transport, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", provider: "openrouter"}
	if err := a.listModels(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(a.models) != 2 || !a.models[0].SupportsTools || a.models[1].SupportsTools {
		t.Fatalf("supportsTools not carried: %+v", a.models)
	}
}

func TestAThreadSurvivesATransportRestart(t *testing.T) {
	server := sseServer(t, http.StatusOK, []string{"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n"}, nil)
	defer server.Close()
	home := t.TempDir()
	n := newNotifications()
	first := testTransportIn(t, "anthropic", server.URL, home, n.notify)
	thread, _ := startThreadAndTurn(t, first, nil, "Hello")
	n.wait(t)
	_ = first.Close()
	second := testTransportIn(t, "anthropic", server.URL, home, n.notify)
	if _, err := second.Call(context.Background(), "thread/resume", map[string]string{"threadId": thread}); err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if _, err := second.Call(context.Background(), "thread/resume", map[string]string{"threadId": "missing"}); err == nil {
		t.Fatal("an unknown thread must not resume")
	}
}

func testTransport(t *testing.T, kind, base string, notify func(string, json.RawMessage)) Transport {
	t.Helper()
	return testTransportIn(t, kind, base, t.TempDir(), notify)
}

func testTransportIn(t *testing.T, kind, base, home string, notify func(string, json.RawMessage)) Transport {
	t.Helper()
	key := "sk-ant-test"
	if kind == "openrouter" {
		key = "sk-or-test"
	}
	transport, err := newHTTPTransport(kind, key, home, notify)
	if err != nil {
		t.Fatal(err)
	}
	transport.(*httpTransport).baseURL = base
	return transport
}
