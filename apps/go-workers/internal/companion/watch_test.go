package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// blockingTransport blocks turn/start on a channel the test controls, so a test can prove a
// watch or read never waits behind a.op while a send is genuinely busy with the provider.
type blockingTransport struct {
	fakeTransport
	block chan struct{}
}

func (b *blockingTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method == "turn/start" {
		<-b.block
	}
	return b.fakeTransport.Call(ctx, method, params)
}

func TestWatchReturnsImmediatelyWhenRevisionExceedsAfter(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	before := a.snapshot(key).Revision

	watch := r
	watch.Operation = "watch"
	watch.After = before - 1
	start := time.Now()
	got, err := a.handle(context.Background(), watch)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("watch waited when the revision already exceeded after")
	}
	if got.Revision != before {
		t.Fatalf("revision changed unexpectedly: got %d, want %d", got.Revision, before)
	}
}

func TestWatchWakesOnBump(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	before := a.snapshot(key).Revision

	done := make(chan Response, 1)
	go func() {
		watch := r
		watch.Operation = "watch"
		watch.After = before
		got, err := a.handle(context.Background(), watch)
		if err != nil {
			t.Error(err)
			return
		}
		done <- got
	}()

	// Give the watch time to register before the bump it must observe.
	time.Sleep(100 * time.Millisecond)
	a.mu.Lock()
	a.bumpLocked(a.conversations[key])
	a.mu.Unlock()

	select {
	case got := <-done:
		if got.Revision <= before {
			t.Fatalf("watch returned without observing the bump: got %d, want > %d", got.Revision, before)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watch did not wake on the bump")
	}
}

func TestWatchReturnsOnDeadlineWithSameRevision(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	before := a.snapshot(key).Revision

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	watch := r
	watch.Operation = "watch"
	watch.After = before
	start := time.Now()
	got, err := a.handle(ctx, watch)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 100*time.Millisecond {
		t.Fatal("watch returned before its deadline")
	}
	if got.Revision != before {
		t.Fatalf("revision changed with no bump: got %d, want %d", got.Revision, before)
	}
}

// TestWatchIsNotBlockedWhileSendHoldsOp proves the ServeHTTP change: a watch (like a read)
// never waits for a.op, so it is never refused "Companion is busy" while a send is in flight.
func TestWatchIsNotBlockedWhileSendHoldsOp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, t.TempDir(), "unused", nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	block := make(chan struct{})
	m.launch = func(_ context.Context, _ string, home string, _ func(string, json.RawMessage)) (Transport, error) {
		if err := os.MkdirAll(home, 0700); err != nil {
			return nil, err
		}
		return &blockingTransport{block: block}, nil
	}

	r := request()
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	sendCode := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
		sendCode <- w.Code
	}()

	// Give the send request time to claim a.op and block inside turn/start.
	time.Sleep(200 * time.Millisecond)

	watchBody, err := json.Marshal(Request{TenantID: r.TenantID, PrincipalID: r.PrincipalID, WorkspaceID: r.WorkspaceID, PetID: r.PetID, Operation: "watch"})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	start := time.Now()
	m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(watchBody)))
	if time.Since(start) > 2*time.Second {
		t.Fatal("watch blocked behind a.op")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("watch refused while send was in flight: %d, body %s", w.Code, w.Body.String())
	}

	close(block)
	if code := <-sendCode; code != http.StatusOK {
		t.Fatalf("send failed: %d", code)
	}
}

// TestWatchCapsConcurrentWatchersPerAccount proves ServeHTTP refuses a watch over the per-account
// cap with 429 at once, before loading anything, while the watches within the cap keep waiting.
func TestWatchCapsConcurrentWatchersPerAccount(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, err := New(ctx, t.TempDir(), "unused", nil, "", "")
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
	// An "after" far in the future means no change can satisfy these watches, so each one within
	// the cap waits until its request context ends.
	body, err := json.Marshal(Request{TenantID: r.TenantID, PrincipalID: r.PrincipalID, WorkspaceID: r.WorkspaceID, PetID: r.PetID, Operation: "watch", After: 1 << 62})
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	var wg sync.WaitGroup
	for i := 0; i < maxConcurrentWatchers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)).WithContext(waitCtx))
		}()
	}
	// Let every watch within the cap register before the one over it arrives.
	time.Sleep(300 * time.Millisecond)
	w := httptest.NewRecorder()
	start := time.Now()
	m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("watch over the cap: got %d, want 429", w.Code)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("watch over the cap waited instead of returning at once")
	}
	stop()
	wg.Wait()
	w = httptest.NewRecorder()
	fresh, err := json.Marshal(Request{TenantID: r.TenantID, PrincipalID: r.PrincipalID, WorkspaceID: r.WorkspaceID, PetID: r.PetID, Operation: "watch"})
	if err != nil {
		t.Fatal(err)
	}
	m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(fresh)))
	if w.Code != http.StatusOK {
		t.Fatalf("watch after the others ended: got %d, want 200 (the cap must be released)", w.Code)
	}
}

// TestDraftsAreCappedAcrossTheConversation proves many large drafts in one turn stop growing
// at maxTotalDraftBytes in total, not 32000 bytes each.
func TestDraftsAreCappedAcrossTheConversation(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	if err := a.load(key); err != nil {
		t.Fatal(err)
	}
	c := a.conversations[key]
	c.ThreadID = "thread"
	c.RequestID = r.RequestID
	c.State = "thinking"
	chunk := strings.Repeat("x", 30000)
	for item := 0; item < 5; item++ {
		raw, _ := json.Marshal(map[string]string{"threadId": "thread", "turnId": "turn", "itemId": "item-" + string(rune('a'+item)), "delta": chunk})
		a.notify("item/agentMessage/delta", raw)
	}
	if total := draftBytes(a.snapshot(key).Messages); total != maxTotalDraftBytes {
		t.Fatalf("draft bytes: got %d, want exactly the cap %d", total, maxTotalDraftBytes)
	}
}

// TestTurnCompletionLogsTimingsWithoutContent proves the per-turn log line carries timings and
// counts but never message text or raw ids.
func TestTurnCompletionLogsTimingsWithoutContent(t *testing.T) {
	var out bytes.Buffer
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected", logger: slog.New(slog.NewJSONHandler(&out, nil))}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	if err := a.load(key); err != nil {
		t.Fatal(err)
	}
	c := a.conversations[key]
	c.ThreadID = "thread"
	c.RequestID = r.RequestID
	c.State = "thinking"
	c.Mode = "chat"
	c.Started = time.Now().Add(-1500 * time.Millisecond)
	c.firstToolAt = c.Started.Add(400 * time.Millisecond)
	c.toolCount = 2
	c.pendingMS = 250
	c.turnEffort = "low"
	c.Messages = append(c.Messages, Message{ID: "secret", Role: "user", Text: "my private question", Actions: []Action{}})
	raw, _ := json.Marshal(map[string]any{"threadId": "thread", "turn": map[string]string{"status": "completed"}})
	a.notify("turn/completed", raw)

	var line map[string]any
	if err := json.Unmarshal(out.Bytes(), &line); err != nil {
		t.Fatalf("log line is not one JSON object: %q", out.String())
	}
	if line["msg"] != "companion turn completed" || line["mode"] != "chat" || line["model"] != "default" || line["effort"] != "low" || line["status"] != "completed" {
		t.Fatalf("unexpected fields: %v", line)
	}
	if line["tool_calls"] != float64(2) || line["pending_ms"] != float64(250) || line["first_tool_ms"] != float64(400) {
		t.Fatalf("unexpected timings: %v", line)
	}
	if total, _ := line["total_ms"].(float64); total < 1500 {
		t.Fatalf("total_ms too small: %v", line["total_ms"])
	}
	for _, leaked := range []string{"my private question", r.WorkspaceID, r.PetID, "thread"} {
		if strings.Contains(out.String(), leaked) {
			t.Fatalf("log line leaks %q: %s", leaked, out.String())
		}
	}
}

// TestRevisionIsMonotonicAcrossReload proves load() seeds a fresh revision from the clock
// on every load, including a genuine restart (a new account reading the same file), rather
// than reusing whatever the last process happened to leave in memory.
func TestRevisionIsMonotonicAcrossReload(t *testing.T) {
	home := t.TempDir()
	r := request()
	key := r.WorkspaceID + "-" + r.PetID

	a := &account{home: home, conversations: map[string]*conversation{}}
	if err := a.load(key); err != nil {
		t.Fatal(err)
	}
	a.conversations[key].Messages = []Message{{ID: "seed", Role: "user", Text: "hi", Actions: []Action{}}}
	a.mu.Lock()
	if err := a.saveLocked(key); err != nil {
		a.mu.Unlock()
		t.Fatal(err)
	}
	a.mu.Unlock()
	first := a.snapshot(key).Revision

	time.Sleep(5 * time.Millisecond)

	b := &account{home: home, conversations: map[string]*conversation{}}
	if err := b.load(key); err != nil {
		t.Fatal(err)
	}
	second := b.snapshot(key).Revision

	if second <= first {
		t.Fatalf("revision not monotonic across reload: first %d, second %d", first, second)
	}
}

// TestDeltaDraftAccumulatesIsNotPersistedAndIsReplacedOnCompletion proves L2.2's streaming
// draft: repeated deltas for the same item accumulate into one draft message, that draft
// never reaches disk, and item/completed removes it and appends the real message in its
// place.
func TestDeltaDraftAccumulatesIsNotPersistedAndIsReplacedOnCompletion(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID

	sendDelta := func(text string) {
		raw, err := json.Marshal(map[string]any{"threadId": "provider-thread", "itemId": "final-item", "delta": text})
		if err != nil {
			t.Fatal(err)
		}
		a.notify("item/agentMessage/delta", raw)
	}
	sendDelta("Hello")
	sendDelta(", world")

	live := a.snapshot(key)
	if len(live.Messages) != 2 {
		t.Fatalf("expected the user message plus one draft, got %+v", live.Messages)
	}
	draft := live.Messages[1]
	if !strings.Contains(draft.ID, ":draft:") || draft.Text != "Hello, world" {
		t.Fatalf("delta did not accumulate into one draft: %+v", draft)
	}

	raw, err := os.ReadFile(filepath.Join(a.home, key+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), ":draft:") {
		t.Fatal("draft message reached disk")
	}

	completed, err := json.Marshal(map[string]any{"threadId": "provider-thread", "item": map[string]string{"id": "final-item", "type": "agentMessage", "text": "Hello, world."}})
	if err != nil {
		t.Fatal(err)
	}
	a.notify("item/completed", completed)
	a.notify("turn/completed", json.RawMessage(`{"threadId":"provider-thread","turn":{"status":"completed"}}`))

	final := a.snapshot(key)
	if len(final.Messages) != 2 {
		t.Fatalf("draft was not replaced in place: %+v", final.Messages)
	}
	if strings.Contains(final.Messages[1].ID, ":draft:") {
		t.Fatal("draft still present after item/completed")
	}
	if final.Messages[1].Text != "Hello, world." {
		t.Fatalf("final message text wrong: %+v", final.Messages[1])
	}
}
