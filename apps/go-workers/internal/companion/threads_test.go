package companion

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// archiveOne archives a one-message live conversation and returns the archive's id.
func archiveOne(t *testing.T, a *account, r Request, key, text string) string {
	t.Helper()
	r.Operation = "read"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	a.conversations[key].Messages = []Message{{ID: "m-" + text, Role: "user", Text: text}}
	r.Operation = "reset"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r.Operation = "history"
	result, err := a.handle(context.Background(), r)
	if err != nil || len(result.History) == 0 {
		t.Fatal("no archive", err)
	}
	return result.History[0].ID
}

func TestRenameLiveAndArchivedKeepsTheEntryAndRefusesBadInput(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	id := archiveOne(t, a, r, key, "Weekly plan")
	r.Operation, r.HistoryID, r.Text = "rename", id, "  Sprint review  "
	result, err := a.handle(context.Background(), r)
	if err != nil || len(result.History) != 1 || result.History[0].ID != id || result.History[0].Title != "Sprint review" {
		t.Fatalf("archived rename: %+v %v", result.History, err)
	}
	r.Operation = "read_history"
	if result, err = a.handle(context.Background(), r); err != nil || len(result.Messages) != 1 {
		t.Fatal("rename lost the archive's messages", err)
	}
	live := request()
	live.Operation, live.Text = "rename", "Live name"
	result, err = a.handle(context.Background(), live)
	if err != nil || result.Title != "Live name" {
		t.Fatalf("live rename: %q %v", result.Title, err)
	}
	live.Operation = "read"
	if result, _ = a.handle(context.Background(), live); result.Title != "Live name" {
		t.Fatal("live title not kept")
	}
	missing := request()
	missing.Operation, missing.Text, missing.HistoryID = "rename", "x", "00000000-0000-4000-8000-000000000000"
	if _, err = a.handle(context.Background(), missing); err == nil {
		t.Fatal("renamed an archive that does not exist")
	}
	foreign := missing
	foreign.HistoryID, foreign.WorkspaceID = id, "99999999-9999-4999-8999-999999999999"
	if _, err = a.handle(context.Background(), foreign); err == nil {
		t.Fatal("cross-workspace rename")
	}
	bad := []Request{
		{Operation: "rename", Text: "   "},
		{Operation: "rename", Text: strings.Repeat("x", 121)},
		{Operation: "rename", Text: "a\nb"},
		{Operation: "rename", Text: "ok", HistoryID: "../../auth"},
		{Operation: "resume_history", Text: "ok"},
		{Operation: "resume_history", HistoryID: "../../auth"},
	}
	for i, b := range bad {
		v := request()
		v.Operation, v.Text, v.HistoryID = b.Operation, b.Text, b.HistoryID
		if validRequest(v) {
			t.Fatalf("bad request %d was accepted", i)
		}
	}
	ok := request()
	ok.Operation, ok.Text = "rename", strings.Repeat("x", 120)
	if !validRequest(ok) {
		t.Fatal("a 120-unit title was refused")
	}
}

func TestResumeSwapsTheLiveConversationWithTheArchive(t *testing.T) {
	tr := &fakeTransport{}
	a := &account{home: t.TempDir(), transport: tr, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	id := archiveOne(t, a, r, key, "Old thread")
	a.conversations[key].Messages = []Message{{ID: "n1", Role: "user", Text: "Current thread"}}
	r.Operation, r.HistoryID = "resume_history", id
	result, err := a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Messages) != 1 || result.Messages[0].Text != "Old thread" || result.Title != "Old thread" || result.State != "idle" {
		t.Fatalf("resumed conversation: %+v", result)
	}
	r.Operation = "history"
	if result, err = a.handle(context.Background(), r); err != nil || len(result.History) != 1 || result.History[0].Title != "Current thread" || result.History[0].ID == id {
		t.Fatalf("the live conversation was not archived in its place: %+v %v", result.History, err)
	}
	if _, err := os.Stat(filepath.Join(a.home, key+"-history", id+".json")); !os.IsNotExist(err) {
		t.Fatal("the resumed archive file was kept")
	}
	// The resumed conversation has no provider thread: the first send carries its transcript, later sends do not.
	turnText := func() string {
		tr.mu.Lock()
		defer tr.mu.Unlock()
		for i := len(tr.calls) - 1; i >= 0; i-- {
			if tr.calls[i] == "turn/start" {
				return tr.params[i].(map[string]any)["input"].([]any)[0].(map[string]any)["text"].(string)
			}
		}
		return ""
	}
	send := request()
	send.Text = "Continue"
	if _, err = a.handle(context.Background(), send); err != nil || !strings.Contains(turnText(), "earlierMessages") || !strings.Contains(turnText(), "Old thread") {
		t.Fatalf("first send after resume lacks the transcript: %v %s", err, turnText())
	}
	a.conversations[key].State = "idle"
	send.RequestID = "66666666-6666-4666-8666-666666666666"
	if _, err = a.handle(context.Background(), send); err != nil || strings.Contains(turnText(), "earlierMessages") {
		t.Fatalf("second send repeats the transcript: %v", err)
	}
	if got := a.snapshot(key); got.Title != "Old thread" {
		t.Fatalf("title changed on send: %q", got.Title)
	}
}

func TestFirstSendSetsTheTitle(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.Text = "Plan   my\nweek"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if got := a.conversations[r.WorkspaceID+"-"+r.PetID].Title; got != "Plan my week" {
		t.Fatalf("title %q", got)
	}
}

func TestResumeIsRefusedWhileThinkingAndHoldsLegacyArchives(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	key := r.WorkspaceID + "-" + r.PetID
	id := archiveOne(t, a, r, key, "Legacy")
	r.Operation, r.HistoryID = "resume_history", id
	a.conversations[key].State = "thinking"
	if _, err := a.handle(context.Background(), r); err == nil {
		t.Fatal("resumed during a running turn")
	}
	live := request()
	live.Operation, live.Text = "rename", "x"
	if _, err := a.handle(context.Background(), live); err == nil {
		t.Fatal("renamed during a running turn")
	}
	a.conversations[key].State = "idle"
	// An archive written before lockedRead existed resumes held; one that recorded false does not.
	path := filepath.Join(a.home, key+"-history", id+".json")
	value, err := readArchive(path)
	if err != nil || value.LockedRead == nil || *value.LockedRead {
		t.Fatalf("archive did not record the hold: %+v %v", value.LockedRead, err)
	}
	value.LockedRead = nil
	if err := writeArchiveFile(filepath.Dir(path), value); err != nil {
		t.Fatal(err)
	}
	foreign := r
	foreign.WorkspaceID = "99999999-9999-4999-8999-999999999999"
	if _, err := a.handle(context.Background(), foreign); err == nil {
		t.Fatal("cross-workspace resume")
	}
	if result, err := a.handle(context.Background(), r); err != nil || !result.LockedRead {
		t.Fatalf("a legacy archive resumed without the hold: %v", err)
	}
	// The hold travels with a live conversation into its archive and back.
	a.conversations[key].LockedRead = true
	r.Operation, r.HistoryID = "reset", ""
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r.Operation = "history"
	result, _ := a.handle(context.Background(), r)
	r.Operation, r.HistoryID = "resume_history", result.History[0].ID
	if result, err = a.handle(context.Background(), r); err != nil || !result.LockedRead {
		t.Fatalf("the hold was lost through archive and resume: %v", err)
	}
}

func TestDefaultTitleUsesTheFirstUserMessage(t *testing.T) {
	got := defaultTitle([]Message{{Role: "system", Text: "notice"}, {Role: "assistant", Text: "hi"}, {Role: "user", Text: "  What   is\n the plan?  "}})
	if got != "What is the plan?" {
		t.Fatalf("title %q", got)
	}
	if defaultTitle([]Message{{Role: "assistant", Text: "hi"}}) != "" {
		t.Fatal("a title was invented without a user message")
	}
	if len([]rune(defaultTitle([]Message{{Role: "user", Text: strings.Repeat("é", 300)}}))) != 120 {
		t.Fatal("title not cut to 120 runes")
	}
}
