package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestNewConversationArchivesHistoryPrivately(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.Operation = "read"
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	key := r.WorkspaceID + "-" + r.PetID
	a.conversations[key].Messages = []Message{{ID: "one", Role: "user", Text: "Weekly plan"}}
	r.Operation = "reset"
	result, err := a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Messages) != 0 {
		t.Fatal("new conversation not empty")
	}
	r.Operation = "history"
	result, err = a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.History) != 1 || result.History[0].Title != "Weekly plan" {
		t.Fatal("history lost")
	}
	r.HistoryID = result.History[0].ID
	r.Operation = "read_history"
	result, err = a.handle(context.Background(), r)
	if err != nil || len(result.Messages) != 1 {
		t.Fatal("archive unreadable", err)
	}
	foreign := r
	foreign.WorkspaceID = "99999999-9999-4999-8999-999999999999"
	if _, err = a.handle(context.Background(), foreign); err == nil {
		t.Fatal("cross-workspace archive read")
	}
	r.HistoryID = "../../auth"
	if _, err = a.handle(context.Background(), r); err == nil {
		t.Fatal("history path traversal")
	}
}

func TestHistoryOverTheCapListsTheNewest(t *testing.T) {
	a := &account{home: t.TempDir(), transport: &fakeTransport{}, conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	dir := filepath.Join(a.home, r.WorkspaceID+"-"+r.PetID+"-history")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// A folded Design history can leave more than 32 entries on disk.
	for i := range 40 {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		entry := archivedConversation{HistoryEntry: HistoryEntry{id, "t", fmt.Sprintf("2026-01-01T00:00:%02dZ", i)}}
		bytes, _ := json.Marshal(entry)
		if err := os.WriteFile(filepath.Join(dir, id+".json"), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	r.Operation = "history"
	result, err := a.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.History) != 32 || result.History[0].CreatedAt != "2026-01-01T00:00:39Z" || result.History[31].CreatedAt != "2026-01-01T00:00:08Z" {
		t.Fatalf("want the newest 32, got %d from %s to %s", len(result.History), result.History[0].CreatedAt, result.History[len(result.History)-1].CreatedAt)
	}
}
