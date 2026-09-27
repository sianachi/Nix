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

// TestWatchCapsConcurrentWatchersPerAccount proves exactly one over-cap watcher skips
// waiting and returns immediately; the 16 within the cap wait for the shared deadline.
func TestWatchCapsConcurrentWatchersPerAccount(t *testing.T) {
	a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	revision := a.snapshot(key).Revision

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	const attempts = 17
	durations := make([]time.Duration, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			watch := r
			watch.Operation = "watch"
			watch.After = revision
			start := time.Now()
			_, _ = a.handle(ctx, watch)
			durations[i] = time.Since(start)
		}(i)
	}
	wg.Wait()

	fast := 0
	for _, d := range durations {
		if d < 500*time.Millisecond {
			fast++
		}
	}
	if fast != 1 {
		t.Fatalf("expected exactly one watcher over the 16 cap to return immediately, got %d", fast)
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
