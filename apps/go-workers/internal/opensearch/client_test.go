package opensearch

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUpsertUsesStableDocumentIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/items/_doc/tenant-1_item-1" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		var document Document
		if err := json.NewDecoder(request.Body).Decode(&document); err != nil || document.TenantID != "tenant-1" {
			t.Fatalf("document = %#v, error = %v", document, err)
		}
		response.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	client := New(server.URL, "items", time.Second)
	if err := client.UpsertDocument(context.Background(), Document{TenantID: "tenant-1", ItemID: "item-1", Title: "Item"}); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureIndexCreatesStrictAuthorizationMapping(t *testing.T) {
	var created bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodHead {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		created = true
		response.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	if err := New(server.URL, "items", time.Second).EnsureIndex(context.Background()); err != nil || !created {
		t.Fatalf("created = %v, error = %v", created, err)
	}
}
