package workerapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConversationToolsCarryActorAndInternalCredentials(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/conversations/"+id+"/tools" || r.Header.Get("X-Nix-Internal-Secret") != "secret" || r.Header.Get("Authorization") != "" {
			t.Error("incorrect endpoint or credentials")
		}
		var body struct {
			TenantID, PrincipalID, RequestID string
			Arguments                        map[string]string
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.TenantID != id || body.PrincipalID != id || body.RequestID != id || body.Arguments["workspaceId"] != id {
			t.Error("actor/source missing")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"result":"partial source evidence","lockedContent":true}`))
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)
	result, success, locked, err := client.ExecuteConversationTool(context.Background(), id, id, id, id, json.RawMessage(`{"operation":"read_note","workspaceId":"`+id+`","itemId":"`+id+`"}`))
	if err != nil || !success || !locked || result != "partial source evidence" {
		t.Fatalf("unexpected result: %q %v %v %v", result, success, locked, err)
	}
	if _, _, _, err = client.ExecuteConversationTool(context.Background(), "../other", id, id, id, json.RawMessage(`{}`)); err == nil {
		t.Fatal("invalid id accepted")
	}
}
