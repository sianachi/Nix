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
	baseURL, secret, owner string
	httpClient             *http.Client
}

type Job struct {
	ID                    string          `json:"id"`
	TenantID              string          `json:"tenantId"`
	WorkspaceID           *string         `json:"workspaceId"`
	ActorID               *string         `json:"actorId"`
	Kind                  string          `json:"kind"`
	Payload               json.RawMessage `json:"payload"`
	Attempts              int             `json:"attempts"`
	CancellationRequested bool            `json:"cancellationRequested"`
}

type OutboxEvent struct {
	ID          string          `json:"id"`
	TenantID    string          `json:"tenantId"`
	WorkspaceID *string         `json:"workspaceId"`
	ItemID      *string         `json:"itemId"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	Attempts    int             `json:"attempts"`
	AvailableAt time.Time       `json:"availableAt"`
}

func New(baseURL, secret, owner string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, owner: owner, httpClient: &http.Client{Timeout: timeout}}
}

func (client *Client) LeaseJobs(ctx context.Context, kind string, limit int) ([]Job, error) {
	var jobs []Job
	if err := client.lease(ctx, "/internal/worker-dispatch/jobs/lease", kind, limit, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (client *Client) CompleteJob(ctx context.Context, id string, succeeded bool, result, errorCode, errorDetail any) error {
	return client.FinishJob(ctx, id, succeeded, false, result, errorCode, errorDetail)
}

func (client *Client) FinishJob(ctx context.Context, id string, succeeded, retryable bool, result, errorCode, errorDetail any) error {
	body, err := json.Marshal(map[string]any{
		"owner": client.owner, "succeeded": succeeded, "retryable": retryable, "result": result,
		"errorCode": errorCode, "errorDetail": errorDetail,
	})
	if err != nil {
		return err
	}
	return client.post(ctx, "/internal/worker-dispatch/jobs/"+id+"/complete", strings.NewReader(string(body)))
}

func (client *Client) LeaseOutbox(ctx context.Context, kind string, limit int) ([]OutboxEvent, error) {
	var events []OutboxEvent
	if err := client.lease(ctx, "/internal/worker-dispatch/outbox/lease", kind, limit, &events); err != nil {
		return nil, err
	}
	return events, nil
}

func (client *Client) lease(ctx context.Context, path, kind string, limit int, target any) error {
	body, err := json.Marshal(struct {
		Owner string `json:"owner"`
		Kind  string `json:"kind,omitempty"`
		Limit int    `json:"limit"`
	}{client.owner, kind, limit})
	if err != nil {
		return err
	}
	request, err := client.newRequest(ctx, http.MethodPost, path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("worker API lease returned %s", response.Status)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(target); err != nil {
		return err
	}
	return nil
}

func (client *Client) AcknowledgeOutbox(ctx context.Context, id string) error {
	return client.finishOutbox(ctx, id, true, "")
}
func (client *Client) FailOutbox(ctx context.Context, id, failure string) error {
	return client.finishOutbox(ctx, id, false, failure)
}

func (client *Client) finishOutbox(ctx context.Context, id string, succeeded bool, failure string) error {
	body, err := json.Marshal(struct {
		Owner     string `json:"owner"`
		Succeeded bool   `json:"succeeded"`
		Error     string `json:"error,omitempty"`
	}{client.owner, succeeded, failure})
	if err != nil {
		return err
	}
	return client.post(ctx, "/internal/worker-dispatch/outbox/"+id+"/finish", strings.NewReader(string(body)))
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
	return request, nil
}
