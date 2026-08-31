package opensearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestUpsertUsesStableDocumentIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/items/_doc/item-1" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		response.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	client := New(server.URL, "items", time.Second)
	if err := client.Upsert(context.Background(), stream.Record{ID: "item-1", Title: "Item"}); err != nil {
		t.Fatal(err)
	}
}
