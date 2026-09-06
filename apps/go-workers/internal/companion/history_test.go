package companion

import (
	"context"
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
	a.conversations[key].Messages = []Message{{ID: "one", Role: "user", Text: "Weekly plan", Actions: []Action{}}}
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
