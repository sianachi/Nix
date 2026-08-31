package workerapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL, secret, bearer, owner string
	httpClient                     *http.Client
}

type OutboxEvent struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	Attempts    int             `json:"attempts"`
	AvailableAt time.Time       `json:"availableAt"`
}

func New(baseURL, secret, bearer, owner string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, bearer: bearer, owner: owner, httpClient: &http.Client{Timeout: timeout}}
}

func (client *Client) LeaseOutbox(ctx context.Context, kind string, limit int) ([]OutboxEvent, error) {
	body, err := json.Marshal(struct {
		Owner string `json:"owner"`
		Kind  string `json:"kind,omitempty"`
		Limit int    `json:"limit"`
	}{client.owner, kind, limit})
	if err != nil {
		return nil, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/internal/worker/outbox/lease", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker API lease returned %s", response.Status)
	}
	var events []OutboxEvent
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&events); err != nil {
		return nil, err
	}
	return events, nil
}

func (client *Client) AcknowledgeOutbox(ctx context.Context, id string) error {
	return client.post(ctx, "/internal/worker/outbox/"+id+"/ack", nil)
}
func (client *Client) FailOutbox(ctx context.Context, id, failure string) error {
	body, _ := json.Marshal(struct {
		Error string `json:"error"`
	}{failure})
	return client.post(ctx, "/internal/worker/outbox/"+id+"/fail", strings.NewReader(string(body)))
}

func (client *Client) post(ctx context.Context, path string, body io.Reader) error {
	request, err := client.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("worker API request returned %s", response.Status)
	}
	return nil
}

func (client *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if client.baseURL == "" {
		return nil, fmt.Errorf("worker API URL is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", client.secret)
	if client.bearer != "" {
		request.Header.Set("Authorization", "Bearer "+client.bearer)
	}
	return request, nil
}
