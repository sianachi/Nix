package workerapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientLeasesAndAcknowledgesWithInternalCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" || request.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("internal credentials were not forwarded")
		}
		if request.URL.Path == "/internal/worker/outbox/lease" {
			_, _ = response.Write([]byte(`[{"id":"event","kind":"item.changed","payload":{},"attempts":1,"availableAt":"2026-01-01T00:00:00Z"}]`))
			return
		}
		if request.URL.Path == "/internal/worker/outbox/event/ack" {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		response.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "token", "indexer", time.Second)
	events, err := client.LeaseOutbox(context.Background(), "item.changed", 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("lease = %#v, %v", events, err)
	}
	if err := client.AcknowledgeOutbox(context.Background(), events[0].ID); err != nil {
		t.Fatal(err)
	}
}
