package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestProviderDefaultUsesAnAdvertisedModelForChatAndInline(t *testing.T) {
	for _, provider := range []string{"anthropic", "openrouter"} {
		for _, mode := range []string{"chat", "inline"} {
			t.Run(provider+"/"+mode, func(t *testing.T) {
				seen := make(chan string, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == http.MethodGet {
						_, _ = fmt.Fprint(w, `{"data":[{"id":"offered-model","display_name":"Offered model","name":"Offered model","supported_parameters":["tools"]}]}`)
						return
					}
					var body struct {
						Model string `json:"model"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					seen <- body.Model
					w.Header().Set("Content-Type", "text/event-stream")
					if provider == "anthropic" {
						_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\n")
					} else {
						_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n")
					}
				}))
				defer server.Close()
				n := newNotifications()
				transport := testTransport(t, provider, server.URL, n.notify)
				defer transport.Close()
				a := &account{transport: transport, home: t.TempDir(), provider: provider, status: "connected", conversations: map[string]*conversation{}}
				if mode == "inline" {
					thread, _, err := a.inlineStart(context.Background(), inlineRequest(), "Private inline material", newInlineRun())
					if err != nil {
						t.Fatal(err)
					}
					defer a.unregisterInline(thread)
				} else if _, err := a.handle(context.Background(), request()); err != nil {
					t.Fatal(err)
				}
				events := n.wait(t)
				if model := <-seen; model != "offered-model" {
					t.Fatalf("request model %q, want the advertised model", model)
				}
				if !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
					t.Fatalf("turn failed: %v", events)
				}
			})
		}
	}
}

func TestAnOpenRouterDefaultWithoutToolsRefusesWorkspaceAccessAndStillChatsWithoutIt(t *testing.T) {
	for _, workspaceAccess := range []bool{false, true} {
		t.Run(fmt.Sprintf("workspaceAccess=%t", workspaceAccess), func(t *testing.T) {
			seen := make(chan struct{}, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					_, _ = fmt.Fprint(w, `{"data":[{"id":"plain-model","name":"Plain model","supported_parameters":["temperature"]}]}`)
					return
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if string(body["model"]) != `"plain-model"` || body["tools"] != nil {
					t.Errorf("plain chat must use its advertised model without tools: %s", body)
				}
				seen <- struct{}{}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, "openrouter", server.URL, n.notify)
			defer transport.Close()
			a := &account{transport: transport, home: t.TempDir(), provider: "openrouter", status: "connected", conversations: map[string]*conversation{}}
			r := request()
			r.WorkspaceAccess = workspaceAccess
			_, err := a.handle(context.Background(), r)
			if workspaceAccess {
				if err == nil || err.Error() != "model does not support tools" {
					t.Fatalf("expected tool support refusal, got %v", err)
				}
				if snapshot := a.snapshot(conversationKey(r)); snapshot.State != "error" || snapshot.Reason != "This model cannot use tools. Pick another model, or turn Workspace access off for this message." {
					t.Fatalf("refusal was not actionable: %+v", snapshot)
				}
				select {
				case <-seen:
					t.Fatal("refused request reached the provider")
				default:
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if events := n.wait(t); !strings.Contains(strings.Join(events, "\n"), `"status":"completed"`) {
				t.Fatalf("plain chat failed: %v", events)
			}
			<-seen
		})
	}
}

func TestEphemeralThreadsAreNeverSavedAndUnsubscribeDiscardsThem(t *testing.T) {
	for _, outcome := range []string{"unused", "completed", "interrupted"} {
		t.Run(outcome, func(t *testing.T) {
			startedRequest := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if outcome == "interrupted" {
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					close(startedRequest)
					<-r.Context().Done()
					return
				}
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Private inline result\"}}]}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			n := newNotifications()
			transport := testTransport(t, "openrouter", server.URL, n.notify)
			defer transport.Close()
			raw, err := transport.Call(context.Background(), "thread/start", map[string]any{"model": "test-model", "ephemeral": true, "baseInstructions": "Private inline context"})
			if err != nil {
				t.Fatal(err)
			}
			var started struct {
				Thread struct{ ID string } `json:"thread"`
			}
			if err := json.Unmarshal(raw, &started); err != nil {
				t.Fatal(err)
			}
			if outcome != "unused" {
				raw, err := transport.Call(context.Background(), "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "Private inline selection"}}})
				if err != nil {
					t.Fatal(err)
				}
				if outcome == "interrupted" {
					var turned struct {
						Turn struct{ ID string } `json:"turn"`
					}
					if err := json.Unmarshal(raw, &turned); err != nil {
						t.Fatal(err)
					}
					select {
					case <-startedRequest:
					case <-time.After(5 * time.Second):
						t.Fatal("provider request never started")
					}
					if _, err := transport.Call(context.Background(), "turn/interrupt", map[string]string{"turnId": turned.Turn.ID}); err != nil {
						t.Fatal(err)
					}
				}
				if events := n.wait(t); !strings.Contains(strings.Join(events, "\n"), `"status":"`+outcome+`"`) {
					t.Fatalf("unexpected outcome: %v", events)
				}
			}
			if _, err := transport.Call(context.Background(), "thread/unsubscribe", map[string]string{"threadId": started.Thread.ID}); err != nil {
				t.Fatal(err)
			}
			http := transport.(*httpTransport)
			if _, err := os.Stat(http.threadPath(started.Thread.ID)); !os.IsNotExist(err) {
				t.Fatalf("ephemeral thread persisted: %v", err)
			}
			http.mu.Lock()
			_, retained := http.threads[started.Thread.ID]
			http.mu.Unlock()
			if retained {
				t.Fatal("ephemeral thread retained in memory")
			}
		})
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

func TestProviderRedirectsCannotReceiveCredentialsOrPrompts(t *testing.T) {
	for _, provider := range []string{"anthropic", "openrouter"} {
		t.Run(provider, func(t *testing.T) {
			received := make(chan string, 1)
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				received <- r.Header.Get("x-api-key") + r.Header.Get("Authorization") + " " + string(body)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer sink.Close()
			origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
			}))
			defer origin.Close()
			n := newNotifications()
			transport := testTransport(t, provider, origin.URL, n.notify).(*httpTransport)
			transport.client.Transport = origin.Client().Transport
			startThreadAndTurn(t, transport, nil, "private test prompt")
			events := strings.Join(n.wait(t), "\n")
			select {
			case leaked := <-received:
				t.Fatalf("provider redirect received credentials or prompt: %s", leaked)
			default:
			}
			if !strings.Contains(events, `"status":"failed"`) || !strings.Contains(events, "HTTP 307") {
				t.Fatalf("redirect did not fail the provider turn: %s", events)
			}
		})
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
