package opensearch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type Document struct {
	TenantID          string         `json:"tenant_id"`
	WorkspaceID       string         `json:"workspace_id,omitempty"`
	ItemID            string         `json:"item_id"`
	ParentID          string         `json:"parent_id,omitempty"`
	AncestorIDs       []string       `json:"ancestor_ids"`
	Title             string         `json:"title"`
	Body              string         `json:"body,omitempty"`
	PropertyText      string         `json:"property_text,omitempty"`
	Properties        map[string]any `json:"properties,omitempty"`
	Links             []string       `json:"links"`
	AuthorizationKeys []string       `json:"authorization_keys"`
	LifecycleState    string         `json:"lifecycle_state,omitempty"`
	SourceVersion     string         `json:"source_version"`
	SourceUpdatedAt   string         `json:"source_updated_at"`
}

type Client struct {
	baseURL, index string
	httpClient     *http.Client
}

func New(baseURL, indexName string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), index: indexName, httpClient: &http.Client{Timeout: timeout}}
}

func (client *Client) EnsureIndex(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, client.baseURL+"/"+client.index, nil)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	if response.StatusCode == http.StatusOK {
		return nil
	}
	if response.StatusCode != http.StatusNotFound {
		return fmt.Errorf("OpenSearch index check returned %s", response.Status)
	}
	mapping := `{"mappings":{"dynamic":"strict","properties":{"tenant_id":{"type":"keyword"},"workspace_id":{"type":"keyword"},"item_id":{"type":"keyword"},"parent_id":{"type":"keyword"},"ancestor_ids":{"type":"keyword"},"title":{"type":"text"},"body":{"type":"text"},"property_text":{"type":"text"},"properties":{"type":"flattened"},"links":{"type":"keyword"},"authorization_keys":{"type":"keyword"},"lifecycle_state":{"type":"keyword"},"source_version":{"type":"keyword"},"source_updated_at":{"type":"date"}}}}`
	return client.request(ctx, http.MethodPut, client.baseURL+"/"+client.index, strings.NewReader(mapping), http.StatusOK, http.StatusCreated)
}

func (client *Client) UpsertDocument(ctx context.Context, document Document) error {
	if document.TenantID == "" || document.ItemID == "" || document.Title == "" {
		return fmt.Errorf("search document requires tenant, item, and title")
	}
	if document.AncestorIDs == nil {
		document.AncestorIDs = []string{}
	}
	if document.Links == nil {
		document.Links = []string{}
	}
	if document.AuthorizationKeys == nil {
		document.AuthorizationKeys = []string{}
	}
	body, err := json.Marshal(document)
	if err != nil {
		return err
	}
	return client.request(ctx, http.MethodPut, client.documentURL(document.TenantID, document.ItemID), strings.NewReader(string(body)), http.StatusOK, http.StatusCreated)
}

func (client *Client) Upsert(ctx context.Context, record stream.Record) error {
	return client.UpsertDocument(ctx, Document{TenantID: "legacy", ItemID: record.ID, ParentID: record.ParentID, Title: record.Title, Body: record.Body, Properties: record.Properties})
}

func (client *Client) Delete(ctx context.Context, tenantID, itemID string) error {
	return client.request(ctx, http.MethodDelete, client.documentURL(tenantID, itemID), nil, http.StatusOK, http.StatusNotFound)
}

func (client *Client) documentURL(tenantID, itemID string) string {
	return client.baseURL + "/" + client.index + "/_doc/" + tenantID + "_" + itemID
}

func (client *Client) request(ctx context.Context, method, target string, body io.Reader, accepted ...int) error {
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	for _, status := range accepted {
		if response.StatusCode == status {
			return nil
		}
	}
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	return fmt.Errorf("OpenSearch request returned %s: %s", response.Status, strings.TrimSpace(string(detail)))
}
