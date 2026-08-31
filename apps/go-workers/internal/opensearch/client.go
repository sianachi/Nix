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

type Client struct {
	baseURL, index string
	httpClient     *http.Client
}

func New(baseURL, indexName string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), index: indexName, httpClient: &http.Client{Timeout: timeout}}
}

func (client *Client) Upsert(ctx context.Context, record stream.Record) error {
	body, err := json.Marshal(map[string]any{"item_id": record.ID, "title": record.Title, "body": record.Body, "properties": record.Properties})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, client.baseURL+"/"+client.index+"/_doc/"+record.ID, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("OpenSearch upsert returned %s: %s", response.Status, strings.TrimSpace(string(detail)))
	}
	return nil
}

func (client *Client) Delete(ctx context.Context, id string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, client.baseURL+"/"+client.index+"/_doc/"+id, nil)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNotFound {
		return fmt.Errorf("OpenSearch delete returned %s", response.Status)
	}
	return nil
}
