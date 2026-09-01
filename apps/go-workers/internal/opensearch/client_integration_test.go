package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestClientAgainstOpenSearch(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("NIX_TEST_OPENSEARCH_URL"), "/")
	if origin == "" {
		t.Skip("NIX_TEST_OPENSEARCH_URL is not configured")
	}

	indexName := fmt.Sprintf("nix-go-integration-%d", time.Now().UnixNano())
	httpClient := &http.Client{Timeout: 10 * time.Second}
	t.Cleanup(func() {
		request, err := http.NewRequest(http.MethodDelete, origin+"/"+indexName, nil)
		if err == nil {
			response, requestErr := httpClient.Do(request)
			if requestErr == nil {
				_ = response.Body.Close()
			}
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := New(origin, indexName, 10*time.Second)
	if err := client.EnsureIndex(ctx); err != nil {
		t.Fatalf("ensure index: %v", err)
	}

	timestamp := time.Date(2026, 9, 1, 12, 0, 0, 123, time.UTC)
	versionOne := int64(1)
	document := Document{
		TenantID:          "11111111-1111-1111-1111-111111111111",
		WorkspaceID:       "22222222-2222-2222-2222-222222222222",
		ItemID:            "33333333-3333-3333-3333-333333333333",
		Type:              "note",
		Title:             "Rabbit index contract",
		Body:              "searchable body",
		Properties:        map[string]any{"status": "open", "nested": map[string]any{"priority": 2}},
		AuthorizationKeys: []string{"workspace:22222222-2222-2222-2222-222222222222"},
		LifecycleState:    "active",
		SourceVersion:     "1",
		SourceUpdatedAt:   timestamp.Format(time.RFC3339Nano),
	}
	created, err := client.Apply(ctx, Mutation{
		Document: document,
		Order: EventOrder{
			AggregateVersion: &versionOne,
			Timestamp:        timestamp,
			OccurredAt:       timestamp,
			EventID:          "44444444-4444-4444-4444-444444444444",
		},
	})
	if err != nil || !created.Applied {
		t.Fatalf("create result = %#v, error = %v", created, err)
	}
	refreshOpenSearchIndex(t, ctx, httpClient, origin, indexName)
	if hits := searchOpenSearchIndex(t, ctx, httpClient, origin, indexName); hits != 1 {
		t.Fatalf("authorized search hits after create = %d", hits)
	}

	staleVersion := int64(1)
	staleDocument := document
	staleDocument.Title = "stale title"
	stale, err := client.Apply(ctx, Mutation{
		Document: staleDocument,
		Order: EventOrder{
			AggregateVersion: &staleVersion,
			Timestamp:        timestamp.Add(-time.Minute),
			OccurredAt:       timestamp.Add(time.Minute),
			EventID:          "55555555-5555-5555-5555-555555555555",
		},
	})
	if err != nil || stale.Applied {
		t.Fatalf("stale result = %#v, error = %v", stale, err)
	}

	versionTwo := int64(2)
	deleted, err := client.Apply(ctx, Mutation{
		Document: document,
		Deleted:  true,
		Order: EventOrder{
			AggregateVersion: &versionTwo,
			Timestamp:        timestamp.Add(2 * time.Minute),
			OccurredAt:       timestamp.Add(2 * time.Minute),
			EventID:          "66666666-6666-6666-6666-666666666666",
		},
	})
	if err != nil || !deleted.Applied {
		t.Fatalf("delete result = %#v, error = %v", deleted, err)
	}
	refreshOpenSearchIndex(t, ctx, httpClient, origin, indexName)
	if hits := searchOpenSearchIndex(t, ctx, httpClient, origin, indexName); hits != 0 {
		t.Fatalf("authorized search hits after tombstone = %d", hits)
	}

	redelivery, err := client.Apply(ctx, Mutation{
		Document: document,
		Order: EventOrder{
			AggregateVersion: &versionOne,
			Timestamp:        timestamp,
			OccurredAt:       timestamp.Add(3 * time.Minute),
			EventID:          "77777777-7777-7777-7777-777777777777",
		},
	})
	if err != nil || redelivery.Applied {
		t.Fatalf("pre-delete redelivery result = %#v, error = %v", redelivery, err)
	}
}

func refreshOpenSearchIndex(t *testing.T, ctx context.Context, client *http.Client, origin, indexName string) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/"+indexName+"/_refresh", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
		t.Fatalf("refresh returned %s: %s", response.Status, detail)
	}
}

func searchOpenSearchIndex(t *testing.T, ctx context.Context, client *http.Client, origin, indexName string) int {
	t.Helper()
	payload := []byte(`{"size":10,"query":{"bool":{"must":[{"multi_match":{"query":"Rabbit","fields":["title^4","body","property_text"]}}],"filter":[{"term":{"tenant_id":"11111111-1111-1111-1111-111111111111"}},{"terms":{"authorization_keys":["workspace:22222222-2222-2222-2222-222222222222"]}},{"term":{"lifecycle_state":"active"}},{"term":{"hidden":false}},{"term":{"deleted":false}}]}}}`)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/"+indexName+"/_search", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
		t.Fatalf("search returned %s: %s", response.Status, detail)
	}
	var result struct {
		Hits struct {
			Total struct {
				Value int `json:"value"`
			} `json:"total"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResultBytes)).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result.Hits.Total.Value
}
