package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

const (
	maxErrorBytes  = 4 << 10
	maxResultBytes = 64 << 10
)

var ErrInvalidMutation = errors.New("invalid OpenSearch mutation")

// ValidateIndexName accepts one exact lower-case index or alias name. Wildcards
// and path syntax are refused so configuration cannot broaden a worker write.
func ValidateIndexName(indexName string) error {
	if indexName == "" || indexName == "." || indexName == ".." || len(indexName) > 255 || indexName[0] == '_' || indexName[0] == '-' || indexName[0] == '+' {
		return errors.New("OpenSearch index name is invalid")
	}
	for _, character := range indexName {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' || character == '_' || character == '.' {
			continue
		}
		return errors.New("OpenSearch index name is invalid")
	}
	return nil
}

type Document struct {
	TenantID          string         `json:"tenant_id"`
	WorkspaceID       string         `json:"workspace_id,omitempty"`
	ItemID            string         `json:"item_id"`
	ParentID          string         `json:"parent_id,omitempty"`
	Type              string         `json:"type"`
	AncestorIDs       []string       `json:"ancestor_ids"`
	Title             string         `json:"title"`
	Body              string         `json:"body,omitempty"`
	PropertyText      string         `json:"property_text,omitempty"`
	Properties        map[string]any `json:"properties,omitempty"`
	Links             []string       `json:"links"`
	AuthorizationKeys []string       `json:"authorization_keys"`
	LifecycleState    string         `json:"lifecycle_state,omitempty"`
	Hidden            bool           `json:"hidden"`
	SourceVersion     string         `json:"source_version"`
	SourceUpdatedAt   string         `json:"source_updated_at"`
}

type EventOrder struct {
	AggregateVersion *int64
	Timestamp        time.Time
	OccurredAt       time.Time
	EventID          string
}

type Mutation struct {
	Document Document
	Deleted  bool
	Order    EventOrder
}

type ApplyResult struct {
	Applied bool
}

// ResponseError preserves whether a failed OpenSearch request is expected to
// recover without changing the workspace event.
type ResponseError struct {
	Operation string
	Status    int
	Detail    string
	Retryable bool
}

func (err *ResponseError) Error() string {
	if err.Status == 0 {
		return fmt.Sprintf("OpenSearch %s failed: %s", err.Operation, err.Detail)
	}
	return fmt.Sprintf("OpenSearch %s returned %d: %s", err.Operation, err.Status, err.Detail)
}

func IsRetryable(err error) bool {
	var responseError *ResponseError
	return errors.As(err, &responseError) && responseError.Retryable
}

type Client struct {
	baseURL, index string
	httpClient     *http.Client
}

func New(baseURL, indexName string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), index: indexName, httpClient: &http.Client{Timeout: timeout}}
}

func (client *Client) EnsureIndex(ctx context.Context) error {
	if err := ValidateIndexName(client.index); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, client.indexURL(), nil)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return transportError("index check", err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxErrorBytes))
	closeErr := response.Body.Close()
	if closeErr != nil {
		return transportError("index check response", closeErr)
	}
	switch response.StatusCode {
	case http.StatusOK:
		return client.request(ctx, http.MethodPut, client.indexURL()+"/_mapping", strings.NewReader(mappingBody), "mapping update", http.StatusOK)
	case http.StatusNotFound:
		return client.request(ctx, http.MethodPut, client.indexURL(), strings.NewReader(createIndexBody), "index creation", http.StatusOK, http.StatusCreated)
	default:
		return statusError("index check", response.StatusCode, "unexpected index status")
	}
}

func (client *Client) Ping(ctx context.Context) error {
	return client.request(ctx, http.MethodGet, client.baseURL+"/_cluster/health", nil, "cluster health", http.StatusOK)
}

// Apply atomically creates, replaces, or tombstones one document only when the
// incoming event is newer than the state already held by OpenSearch.
func (client *Client) Apply(ctx context.Context, mutation Mutation) (ApplyResult, error) {
	if err := validateMutation(mutation); err != nil {
		return ApplyResult{}, err
	}
	normalizeDocument(&mutation.Document)
	stored := storedDocument{
		Document:         mutation.Document,
		Deleted:          mutation.Deleted,
		AggregateVersion: mutation.Order.AggregateVersion,
		SourceOrderAt:    orderedTime(mutation.Order.Timestamp),
		SourceEventAt:    orderedTime(mutation.Order.OccurredAt),
		SourceEventID:    mutation.Order.EventID,
	}
	payload := updatePayload{ScriptedUpsert: true, Upsert: map[string]any{}}
	payload.Script.Language = "painless"
	payload.Script.Source = guardedMutationScript
	payload.Script.Params.Incoming = stored
	payload.Script.Params.AggregateVersion = mutation.Order.AggregateVersion
	payload.Script.Params.OrderTimestamp = stored.SourceOrderAt
	payload.Script.Params.EventID = mutation.Order.EventID
	body, err := json.Marshal(payload)
	if err != nil {
		return ApplyResult{}, errors.Join(ErrInvalidMutation, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.updateURL(mutation.Document.TenantID, mutation.Document.ItemID)+"?retry_on_conflict=3", bytes.NewReader(body))
	if err != nil {
		return ApplyResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ApplyResult{}, transportError("document mutation", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
		return ApplyResult{}, statusError("document mutation", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	resultBody, err := io.ReadAll(io.LimitReader(response.Body, maxResultBytes+1))
	if err != nil {
		return ApplyResult{}, transportError("document mutation response", err)
	}
	if len(resultBody) > maxResultBytes {
		return ApplyResult{}, transportError("document mutation response", errors.New("response limit exceeded"))
	}
	var result struct {
		Result string `json:"result"`
	}
	decoder := json.NewDecoder(bytes.NewReader(resultBody))
	if err := decoder.Decode(&result); err != nil {
		return ApplyResult{}, transportError("document mutation response", err)
	}
	switch result.Result {
	case "created", "updated":
		return ApplyResult{Applied: true}, nil
	case "noop":
		return ApplyResult{}, nil
	default:
		return ApplyResult{}, transportError("document mutation response", fmt.Errorf("unexpected result %q", result.Result))
	}
}

// UpsertDocument remains for the standalone authenticated HTTP index surface.
func (client *Client) UpsertDocument(ctx context.Context, document Document) error {
	timestamp := time.Now().UTC()
	if parsed, err := time.Parse(time.RFC3339Nano, document.SourceUpdatedAt); err == nil {
		timestamp = parsed
	}
	_, err := client.Apply(ctx, Mutation{Document: document, Order: EventOrder{Timestamp: timestamp, OccurredAt: timestamp, EventID: "legacy:" + document.TenantID + ":" + document.ItemID}})
	return err
}

func (client *Client) Upsert(ctx context.Context, record stream.Record) error {
	now := time.Now().UTC()
	return client.UpsertDocument(ctx, Document{TenantID: "legacy", WorkspaceID: "legacy", ItemID: record.ID, ParentID: record.ParentID, Type: "note", Title: record.Title, Body: record.Body, Properties: record.Properties, LifecycleState: "active", SourceVersion: "legacy", SourceUpdatedAt: now.Format(time.RFC3339Nano)})
}

// Delete writes a tombstone so an older redelivery cannot recreate the item.
func (client *Client) Delete(ctx context.Context, tenantID, itemID string) error {
	now := time.Now().UTC()
	_, err := client.Apply(ctx, Mutation{Document: Document{TenantID: tenantID, WorkspaceID: "legacy", ItemID: itemID, Title: "", SourceVersion: "legacy", SourceUpdatedAt: now.Format(time.RFC3339Nano)}, Deleted: true, Order: EventOrder{Timestamp: now, OccurredAt: now, EventID: "legacy-delete:" + tenantID + ":" + itemID}})
	return err
}

func (client *Client) documentURL(tenantID, itemID string) string {
	return client.indexURL() + "/_doc/" + url.PathEscape(tenantID+"_"+itemID)
}

func (client *Client) updateURL(tenantID, itemID string) string {
	return client.indexURL() + "/_update/" + url.PathEscape(tenantID+"_"+itemID)
}

func (client *Client) indexURL() string {
	return client.baseURL + "/" + url.PathEscape(client.index)
}

func (client *Client) request(ctx context.Context, method, target string, body io.Reader, operation string, accepted ...int) error {
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return transportError(operation, err)
	}
	defer response.Body.Close()
	for _, status := range accepted {
		if response.StatusCode == status {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxErrorBytes))
			return nil
		}
	}
	detail, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
	return statusError(operation, response.StatusCode, strings.TrimSpace(string(detail)))
}

type storedDocument struct {
	Document
	Deleted          bool   `json:"deleted"`
	AggregateVersion *int64 `json:"aggregate_version,omitempty"`
	SourceOrderAt    string `json:"source_order_at"`
	SourceEventAt    string `json:"source_event_at"`
	SourceEventID    string `json:"source_event_id"`
}

type updatePayload struct {
	ScriptedUpsert bool `json:"scripted_upsert"`
	Script         struct {
		Language string `json:"lang"`
		Source   string `json:"source"`
		Params   struct {
			Incoming         storedDocument `json:"incoming"`
			AggregateVersion *int64         `json:"aggregate_version"`
			OrderTimestamp   string         `json:"order_timestamp"`
			EventID          string         `json:"event_id"`
		} `json:"params"`
	} `json:"script"`
	Upsert map[string]any `json:"upsert"`
}

func validateMutation(mutation Mutation) error {
	document := mutation.Document
	if strings.TrimSpace(document.TenantID) == "" || strings.TrimSpace(document.WorkspaceID) == "" || strings.TrimSpace(document.ItemID) == "" || !mutation.Deleted && strings.TrimSpace(document.Type) == "" || mutation.Order.Timestamp.IsZero() || mutation.Order.OccurredAt.IsZero() || strings.TrimSpace(mutation.Order.EventID) == "" || len(mutation.Order.EventID) > 128 || mutation.Order.AggregateVersion != nil && *mutation.Order.AggregateVersion <= 0 {
		return ErrInvalidMutation
	}
	return nil
}

func normalizeDocument(document *Document) {
	if document.AncestorIDs == nil {
		document.AncestorIDs = []string{}
	}
	if document.Links == nil {
		document.Links = []string{}
	}
	if document.AuthorizationKeys == nil {
		document.AuthorizationKeys = []string{}
	}
}

func orderedTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func transportError(operation string, err error) error {
	return &ResponseError{Operation: operation, Detail: err.Error(), Retryable: true}
}

func statusError(operation string, status int, detail string) error {
	if detail == "" {
		detail = http.StatusText(status)
	}
	retryable := status != http.StatusBadRequest && status != http.StatusRequestEntityTooLarge && status != http.StatusUnprocessableEntity
	return &ResponseError{Operation: operation, Status: status, Detail: detail, Retryable: retryable}
}

const guardedMutationScript = `
if (ctx.op == 'create') {
  ctx._source.putAll(params.incoming);
  return;
}
def currentVersion = ctx._source.containsKey('aggregate_version') ? ctx._source.aggregate_version : null;
boolean hasCurrentOrder = ctx._source.containsKey('source_order_at');
def currentOrder = hasCurrentOrder ? ctx._source.source_order_at : '';
def currentEventID = ctx._source.containsKey('source_event_id') ? ctx._source.source_event_id : '';
def incomingVersion = params.aggregate_version;
boolean apply = false;
if (incomingVersion != null && currentVersion != null) {
  long incomingLong = incomingVersion.longValue();
  long currentLong = currentVersion.longValue();
  apply = incomingLong > currentLong;
  if (incomingLong == currentLong) {
    int timestampOrder = params.order_timestamp.compareTo(currentOrder);
    apply = timestampOrder > 0 || (timestampOrder == 0 && params.event_id.compareTo(currentEventID) > 0);
  }
} else if (incomingVersion != null) {
  apply = true;
} else if (currentVersion == null) {
  if (!hasCurrentOrder) {
    apply = true;
  } else {
    int timestampOrder = params.order_timestamp.compareTo(currentOrder);
    apply = timestampOrder > 0 || (timestampOrder == 0 && params.event_id.compareTo(currentEventID) > 0);
  }
}
if (apply) {
  ctx._source.clear();
  ctx._source.putAll(params.incoming);
} else {
  ctx.op = 'none';
}`

const mappingBody = `{"dynamic":"strict","properties":{"tenant_id":{"type":"keyword"},"workspace_id":{"type":"keyword"},"item_id":{"type":"keyword"},"parent_id":{"type":"keyword"},"type":{"type":"keyword"},"ancestor_ids":{"type":"keyword"},"title":{"type":"text"},"body":{"type":"text"},"property_text":{"type":"text"},"properties":{"type":"flat_object"},"links":{"type":"keyword"},"authorization_keys":{"type":"keyword"},"lifecycle_state":{"type":"keyword"},"hidden":{"type":"boolean"},"source_version":{"type":"keyword"},"source_updated_at":{"type":"date"},"deleted":{"type":"boolean"},"aggregate_version":{"type":"long"},"source_order_at":{"type":"date_nanos","format":"strict_date_optional_time_nanos"},"source_event_at":{"type":"date_nanos","format":"strict_date_optional_time_nanos"},"source_event_id":{"type":"keyword"}}}`

const createIndexBody = `{"settings":{"index":{"number_of_shards":1,"number_of_replicas":0}},"mappings":` + mappingBody + `}`
