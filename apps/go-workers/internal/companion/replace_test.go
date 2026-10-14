package companion

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestReplaceFromMessageDropsTheTurnAndStartsAFreshThread(t *testing.T) {
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	messages := []Message{
		{ID: "u1", Role: "user", Text: "First"},
		{ID: "u1:assistant", Role: "assistant", Text: "First reply"},
		{ID: "u2", Role: "user", Text: "Second"},
		{ID: "u2:assistant", Role: "assistant", Text: "Second reply"},
	}
	transport := &fakeTransport{}
	a := &account{transport: transport, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	a.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "old-thread", State: "idle", Messages: append([]Message{}, messages...)}

	r.ReplaceFromMessageID = "u2"
	r.Text = "Better second"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if transport.calls[0] != "thread/start" {
		t.Fatalf("a replacing send must not resume the old thread: %v", transport.calls)
	}
	got := a.snapshot(key).Messages
	if len(got) != 3 || got[0].ID != "u1" || got[1].ID != "u1:assistant" || got[2].ID != r.RequestID || got[2].Text != "Better second" {
		t.Fatalf("the replaced turn was not dropped: %+v", got)
	}
	prompt := ""
	for i, call := range transport.calls {
		if call == "turn/start" {
			raw, _ := json.Marshal(transport.params[i])
			prompt = string(raw)
		}
	}
	if !strings.Contains(prompt, "First reply") || strings.Contains(prompt, "Second reply") {
		t.Fatalf("fresh thread did not get exactly the retained messages: %s", prompt)
	}
}

func TestReplaceFromMessageRefusesNonUserTargetsAndRunningTurns(t *testing.T) {
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	seed := func(state string) *account {
		a := &account{transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
		a.conversations[key] = &conversation{ToolVersion: toolVersion, ThreadID: "t", State: state, Messages: []Message{
			{ID: "u1", Role: "user", Text: "First"}, {ID: "u1:assistant", Role: "assistant", Text: "Reply"},
		}}
		return a
	}
	for _, target := range []string{"u1:assistant", "66666666-6666-4666-8666-666666666666"} {
		a := seed("idle")
		r.ReplaceFromMessageID = target
		if _, err := a.handle(context.Background(), r); !errors.Is(err, errReplaceTarget) {
			t.Fatalf("%s: err = %v, want errReplaceTarget", target, err)
		}
		if len(a.snapshot(key).Messages) != 2 {
			t.Fatalf("%s: a refused replace changed the conversation", target)
		}
	}
	a := seed("thinking")
	r.ReplaceFromMessageID = "u1"
	if _, err := a.handle(context.Background(), r); !errors.Is(err, errReplaceBusy) {
		t.Fatalf("running turn: err = %v, want errReplaceBusy", err)
	}
	bad := request()
	bad.ReplaceFromMessageID = "not-a-uuid"
	if validRequest(bad) {
		t.Fatal("a non-uuid replace id was accepted")
	}
}

func TestSharedItemsAreBoundedAndReachThePrompt(t *testing.T) {
	r := request()
	item := func(id string) SharedItem { return SharedItem{ID: id, Title: "Title " + id[:1]} }
	r.ItemID = "66666666-6666-4666-8666-666666666666"
	r.Items = []SharedItem{item(r.ItemID), item("77777777-7777-4777-8777-777777777777")}
	if !validRequest(r) {
		t.Fatal("two attached items were refused")
	}
	prompt := turnPrompt(r, true)
	shared, ok := prompt["sharedItems"].([]SharedItem)
	if !ok || len(shared) != 2 || shared[1].Title != "Title 7" || prompt["currentItemId"] != r.ItemID {
		t.Fatalf("attached items missing from the prompt: %+v", prompt)
	}
	single := request()
	single.ItemID = r.ItemID
	single.Items = r.Items[:1]
	if _, ok := turnPrompt(single, true)["sharedItems"]; ok {
		t.Fatal("a single item should keep the old prompt shape")
	}
	over := r
	over.Items = make([]SharedItem, maxSharedItems+1)
	for i := range over.Items {
		over.Items[i] = item(r.ItemID)
	}
	if validRequest(over) {
		t.Fatal("more than the cap was accepted")
	}
	long := r
	long.Items = []SharedItem{{ID: r.ItemID, Title: strings.Repeat("x", 241)}}
	if validRequest(long) {
		t.Fatal("an over-long title was accepted")
	}
}
