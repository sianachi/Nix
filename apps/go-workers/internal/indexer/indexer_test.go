package indexer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func TestProcessQualifiesDocumentsByTenantAndDeletes(t *testing.T) {
	requests := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests <- request.Method + " " + request.URL.Path
		if request.Method == http.MethodPut {
			response.WriteHeader(http.StatusCreated)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	search := opensearch.New(server.URL, "items", time.Second)
	memory := index.New(100, 10)
	itemID := "item-1"
	payload, _ := json.Marshal(opensearch.Document{ItemID: itemID, Title: "Visible", AuthorizationKeys: []string{"principal:one"}})
	changed := workerapi.OutboxEvent{TenantID: "tenant-1", ItemID: &itemID, Kind: "item.changed", Payload: payload}
	if err := Process(context.Background(), changed, memory, search); err != nil {
		t.Fatal(err)
	}
	deleted := workerapi.OutboxEvent{TenantID: "tenant-1", ItemID: &itemID, Kind: "item.deleted"}
	if err := Process(context.Background(), deleted, memory, search); err != nil {
		t.Fatal(err)
	}
	if memory.Len() != 0 {
		t.Fatalf("indexed records = %d", memory.Len())
	}
	if first, second := <-requests, <-requests; first != "PUT /items/_doc/tenant-1_item-1" || second != "DELETE /items/_doc/tenant-1_item-1" {
		t.Fatalf("requests = %q, %q", first, second)
	}
}

func TestProcessRejectsEnvelopePayloadIdentityMismatch(t *testing.T) {
	itemID := "item-1"
	payload, _ := json.Marshal(opensearch.Document{ItemID: "item-2", Title: "Wrong"})
	err := Process(context.Background(), workerapi.OutboxEvent{TenantID: "tenant-1", ItemID: &itemID, Kind: "item.changed", Payload: payload}, index.New(100, 10), nil)
	if err == nil {
		t.Fatal("mismatched item identity was accepted")
	}
}
