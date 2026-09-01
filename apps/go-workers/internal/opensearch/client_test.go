package opensearch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestApplyUsesAnAtomicVersionGuardAndStableIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/items/_update/tenant-1_item-1" || request.URL.Query().Get("retry_on_conflict") != "3" {
			t.Fatalf("request = %s %s", request.Method, request.URL.String())
		}
		var payload updatePayload
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if !payload.ScriptedUpsert || payload.Script.Params.AggregateVersion == nil || *payload.Script.Params.AggregateVersion != 7 || payload.Script.Params.Incoming.TenantID != "tenant-1" || payload.Script.Params.Incoming.AuthorizationKeys[0] != "principal:one" || !strings.Contains(payload.Script.Source, "currentVersion") {
			t.Fatalf("update payload = %#v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"result":"updated"}`))
	}))
	defer server.Close()

	version := int64(7)
	result, err := New(server.URL, "items", time.Second).Apply(context.Background(), mutation(version, false))
	if err != nil || !result.Applied {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func TestApplyReportsStaleNoopAndWritesDeleteTombstone(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		var payload updatePayload
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if requests == 2 && (!payload.Script.Params.Incoming.Deleted || payload.Script.Params.Incoming.AuthorizationKeys == nil) {
			t.Fatalf("delete was not represented by a bounded tombstone: %#v", payload.Script.Params.Incoming)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"result":"noop"}`))
	}))
	defer server.Close()
	client := New(server.URL, "items", time.Second)

	if result, err := client.Apply(context.Background(), mutation(1, false)); err != nil || result.Applied {
		t.Fatalf("stale result = %#v, %v", result, err)
	}
	if result, err := client.Apply(context.Background(), mutation(2, true)); err != nil || result.Applied {
		t.Fatalf("delete result = %#v, %v", result, err)
	}
}

func TestEnsureIndexCreatesAndUpdatesStrictAuthorizationMapping(t *testing.T) {
	for name, exists := range map[string]bool{"create": false, "update": true} {
		t.Run(name, func(t *testing.T) {
			var target string
			var mapping string
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodHead {
					if exists {
						response.WriteHeader(http.StatusOK)
					} else {
						response.WriteHeader(http.StatusNotFound)
					}
					return
				}
				target = request.URL.Path
				var value map[string]any
				if err := json.NewDecoder(request.Body).Decode(&value); err != nil {
					t.Fatal(err)
				}
				encoded, _ := json.Marshal(value)
				mapping = string(encoded)
				response.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			if err := New(server.URL, "items", time.Second).EnsureIndex(context.Background()); err != nil {
				t.Fatal(err)
			}
			expectedTarget := "/items"
			if exists {
				expectedTarget += "/_mapping"
			}
			if target != expectedTarget || !strings.Contains(mapping, `"dynamic":"strict"`) || !strings.Contains(mapping, `"tenant_id":{"type":"keyword"}`) || !strings.Contains(mapping, `"type":{"type":"keyword"}`) || !strings.Contains(mapping, `"properties":{"type":"flat_object"}`) || !strings.Contains(mapping, `"authorization_keys":{"type":"keyword"}`) || !strings.Contains(mapping, `"hidden":{"type":"boolean"}`) || !strings.Contains(mapping, `"deleted":{"type":"boolean"}`) || !strings.Contains(mapping, `"aggregate_version":{"type":"long"}`) {
				t.Fatalf("target = %q, mapping = %s", target, mapping)
			}
		})
	}
}

func TestOpenSearchFailuresAreClassified(t *testing.T) {
	for status, retryable := range map[int]bool{
		http.StatusBadRequest:            false,
		http.StatusRequestEntityTooLarge: false,
		http.StatusUnauthorized:          true,
		http.StatusTooManyRequests:       true,
		http.StatusServiceUnavailable:    true,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(status)
			}))
			defer server.Close()
			_, err := New(server.URL, "items", time.Second).Apply(context.Background(), mutation(1, false))
			if err == nil || IsRetryable(err) != retryable {
				t.Fatalf("error = %v, retryable = %v", err, IsRetryable(err))
			}
		})
	}
	client := New("http://127.0.0.1:1", "items", 50*time.Millisecond)
	if _, err := client.Apply(context.Background(), mutation(1, false)); err == nil || !IsRetryable(err) {
		t.Fatalf("network error = %v", err)
	}
}

func mutation(version int64, deleted bool) Mutation {
	timestamp := time.Date(2026, 9, 1, 12, 0, 0, 123, time.UTC)
	return Mutation{
		Document: Document{
			TenantID: "tenant-1", WorkspaceID: "workspace-1", ItemID: "item-1", Type: "note", Title: "Item",
			AuthorizationKeys: []string{"principal:one"}, LifecycleState: "active", SourceVersion: "7", SourceUpdatedAt: timestamp.Format(time.RFC3339Nano),
		},
		Deleted: deleted,
		Order:   EventOrder{AggregateVersion: &version, Timestamp: timestamp, OccurredAt: timestamp.Add(time.Second), EventID: "event-1"},
	}
}

func TestInvalidMutationIsPermanentBeforeNetwork(t *testing.T) {
	_, err := New("http://127.0.0.1:1", "items", time.Second).Apply(context.Background(), Mutation{})
	if !errors.Is(err, ErrInvalidMutation) {
		t.Fatalf("error = %v", err)
	}
}

func TestIndexNameIsExactAndPathSafe(t *testing.T) {
	for _, name := range []string{"", ".", "..", "_hidden", "-alias", "+alias", "Nix", "nix/items", "nix*"} {
		if err := ValidateIndexName(name); err == nil {
			t.Fatalf("index name %q was accepted", name)
		}
	}
	if err := ValidateIndexName("nix-items_v1.2"); err != nil {
		t.Fatalf("safe index name was refused: %v", err)
	}
}
