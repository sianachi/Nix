package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginworker"
)

const (
	maxIndexMetadataBytes = 256 << 10
	MaxIndexBodyBytes     = 2 << 20
)

var ErrResponseTooLarge = errors.New("worker API response exceeds its size limit")

type Client struct {
	baseURL, secret, owner string
	httpClient             *http.Client
}

type executionContextKey struct{}

type executionContext struct {
	jobID       string
	executionID string
}

// WithExecution binds domain API requests to the exact live lease handling the job.
func WithExecution(ctx context.Context, jobID, executionID string) context.Context {
	return context.WithValue(ctx, executionContextKey{}, executionContext{jobID: jobID, executionID: executionID})
}

func Execution(ctx context.Context) (jobID, executionID string, ok bool) {
	execution, ok := ctx.Value(executionContextKey{}).(executionContext)
	if !ok {
		return "", "", false
	}
	return execution.jobID, execution.executionID, true
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

// IndexItemMetadata is the authoritative, body-free search projection hydrated
// from Nix.Api for a workspace event.
type IndexItemMetadata struct {
	TenantID          string         `json:"tenant_id"`
	WorkspaceID       string         `json:"workspace_id"`
	ItemID            string         `json:"item_id"`
	ParentID          string         `json:"parent_id,omitempty"`
	ItemType          string         `json:"item_type"`
	AncestorIDs       []string       `json:"ancestor_ids"`
	Title             string         `json:"title"`
	PropertyText      string         `json:"property_text,omitempty"`
	Properties        map[string]any `json:"properties,omitempty"`
	Links             []string       `json:"links"`
	AuthorizationKeys []string       `json:"authorization_keys"`
	LifecycleState    string         `json:"lifecycle_state,omitempty"`
	Indexable         bool           `json:"indexable"`
	SourceUpdatedAt   string         `json:"source_updated_at"`
}

type IndexRebuildRequest struct {
	AfterTenantID *string    `json:"afterTenantId,omitempty"`
	AfterItemID   *string    `json:"afterItemId,omitempty"`
	UpdatedSince  *time.Time `json:"updatedSince,omitempty"`
	Limit         *int       `json:"limit,omitempty"`
}

type IndexRebuildPage struct {
	Enqueued     int     `json:"enqueued"`
	NextTenantID *string `json:"nextTenantId"`
	NextItemID   *string `json:"nextItemId"`
	HasMore      bool    `json:"hasMore"`
}

type IndexQueueStatus struct {
	Pending           int64      `json:"pending"`
	OldestAvailableAt *time.Time `json:"oldestAvailableAt"`
	HighestAttempts   int        `json:"highestAttempts"`
	PendingFailures   int64      `json:"pendingFailures"`
}

type JobState struct {
	Status                string     `json:"status"`
	CancellationRequested bool       `json:"cancellationRequested"`
	LeaseOwned            bool       `json:"leaseOwned"`
	LeaseUntil            *time.Time `json:"leaseUntil"`
}

type FileInspection struct {
	UploadID             string    `json:"uploadId"`
	WorkspaceID          string    `json:"workspaceId"`
	Status               string    `json:"status"`
	FileName             string    `json:"fileName"`
	DeclaredMediaType    string    `json:"declaredMediaType"`
	DeclaredByteLength   int64     `json:"declaredByteLength"`
	ExpiresAt            time.Time `json:"expiresAt"`
	SourceURL            string    `json:"sourceUrl"`
	SourceDeleteURL      string    `json:"sourceDeleteUrl"`
	DestinationURL       string    `json:"destinationUrl"`
	DestinationUploadURL string    `json:"destinationUploadUrl"`
	DestinationDeleteURL string    `json:"destinationDeleteUrl"`
	CapabilityExpires    time.Time `json:"capabilityExpiresAt"`
	ItemID               *string   `json:"itemId"`
}

type InspectedFile struct {
	DetectedMediaType string `json:"detectedMediaType"`
	ByteLength        int64  `json:"byteLength"`
	SHA256            string `json:"sha256"`
	Previewable       bool   `json:"previewable"`
	PixelWidth        *int   `json:"pixelWidth"`
	PixelHeight       *int   `json:"pixelHeight"`
}

type PublishedFile struct {
	ItemID      string `json:"itemId"`
	WorkspaceID string `json:"workspaceId"`
}

type ObjectCleanupCapability struct {
	OwnerKind  string    `json:"ownerKind"`
	OwnerID    string    `json:"ownerId"`
	NotBefore  time.Time `json:"notBefore"`
	DeleteURLs []string  `json:"deleteUrls"`
	NextOffset *int      `json:"nextOffset"`
}

type DocumentImportPreview struct {
	ImportID           string    `json:"importId"`
	Format             string    `json:"format"`
	Title              string    `json:"title"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanUploadURL      string    `json:"planUploadUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type DocumentImportCommit struct {
	ImportID           string    `json:"importId"`
	Format             string    `json:"format"`
	Title              string    `json:"title"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	PlanSHA256         string    `json:"planSha256"`
	PlanByteLength     int64     `json:"planByteLength"`
	SourceSHA256       string    `json:"sourceSha256"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanURL            string    `json:"planUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type CompleteDocumentImportPreview struct {
	PlanSHA256     string   `json:"planSha256"`
	PlanByteLength int64    `json:"planByteLength"`
	SourceSHA256   string   `json:"sourceSha256"`
	ItemCount      int      `json:"itemCount"`
	AssetCount     int      `json:"assetCount"`
	Loss           []string `json:"loss"`
	Omissions      []string `json:"omissions"`
}

type DocumentImportFile struct {
	SourceKind  string  `json:"sourceKind"`
	AssetPath   *string `json:"assetPath,omitempty"`
	FileName    string  `json:"fileName"`
	MediaType   string  `json:"mediaType"`
	ByteLength  int64   `json:"byteLength"`
	SHA256      string  `json:"sha256"`
	Previewable bool    `json:"previewable"`
	PixelWidth  *int    `json:"pixelWidth,omitempty"`
	PixelHeight *int    `json:"pixelHeight,omitempty"`
}

type DocumentImportStageItem struct {
	SourceID            string              `json:"sourceId"`
	ParentSourceID      *string             `json:"parentSourceId"`
	Order               int                 `json:"order"`
	Title               string              `json:"title"`
	ItemType            string              `json:"itemType"`
	Properties          json.RawMessage     `json:"properties,omitempty"`
	Schema              json.RawMessage     `json:"schema,omitempty"`
	Views               json.RawMessage     `json:"views,omitempty"`
	FinalLifecycleState string              `json:"finalLifecycleState"`
	BodyRequired        bool                `json:"bodyRequired"`
	File                *DocumentImportFile `json:"file,omitempty"`
}

type DocumentImportStageRequest struct {
	PlanSHA256   string                    `json:"planSha256"`
	SourceSHA256 string                    `json:"sourceSha256"`
	Items        []DocumentImportStageItem `json:"items"`
}

type DocumentImportStage struct {
	ImportID   string                       `json:"importId"`
	RootItemID string                       `json:"rootItemId"`
	Items      []DocumentImportStageMapping `json:"items"`
}

type DocumentImportStageMapping struct {
	SourceID     string `json:"sourceId"`
	TargetItemID string `json:"targetItemId"`
	ItemType     string `json:"itemType"`
	BodyRequired bool   `json:"bodyRequired"`
	ObjectReady  bool   `json:"objectReady"`
}

type DocumentImportObjectCapability struct {
	SourceID          string    `json:"sourceId"`
	URL               string    `json:"url"`
	UploadURL         string    `json:"uploadUrl"`
	DeleteURL         string    `json:"deleteUrl"`
	CapabilityExpires time.Time `json:"capabilityExpiresAt"`
}

type DocumentImportResult struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"`
	RootItemID *string `json:"rootItemId"`
}

type TemplateImportProfile struct {
	Kind            string `json:"kind"`
	Version         int    `json:"version"`
	Key             string `json:"key"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	IncludeBody     bool   `json:"includeBody"`
	IncludeChildren bool   `json:"includeChildren"`
}

type TemplateImportPreview struct {
	ImportID           string    `json:"importId"`
	WorkspaceID        string    `json:"workspaceId"`
	Origin             string    `json:"origin"`
	ManagedSource      *string   `json:"managedSource"`
	IdempotencyKey     string    `json:"idempotencyKey"`
	FileName           string    `json:"fileName"`
	DeclaredMediaType  string    `json:"declaredMediaType"`
	DeclaredByteLength int64     `json:"declaredByteLength"`
	SourceURL          string    `json:"sourceUrl"`
	SourceDeleteURL    string    `json:"sourceDeleteUrl"`
	PlanUploadURL      string    `json:"planUploadUrl"`
	PlanDeleteURL      string    `json:"planDeleteUrl"`
	CapabilityExpires  time.Time `json:"capabilityExpiresAt"`
}

type TemplateImportCommit struct {
	ImportID           string                `json:"importId"`
	WorkspaceID        string                `json:"workspaceId"`
	Origin             string                `json:"origin"`
	ManagedSource      *string               `json:"managedSource"`
	IdempotencyKey     string                `json:"idempotencyKey"`
	FileName           string                `json:"fileName"`
	DeclaredMediaType  string                `json:"declaredMediaType"`
	DeclaredByteLength int64                 `json:"declaredByteLength"`
	SourceURL          string                `json:"sourceUrl"`
	SourceDeleteURL    string                `json:"sourceDeleteUrl"`
	PlanUploadURL      string                `json:"planUploadUrl"`
	PlanDeleteURL      string                `json:"planDeleteUrl"`
	CapabilityExpires  time.Time             `json:"capabilityExpiresAt"`
	PlanSHA256         string                `json:"planSha256"`
	PlanByteLength     int64                 `json:"planByteLength"`
	SourceSHA256       string                `json:"sourceSha256"`
	PlanURL            string                `json:"planUrl"`
	CompletedResult    *TemplateImportResult `json:"completedResult"`
}

type CompleteTemplateImportPreview struct {
	Profile        TemplateImportProfile `json:"profile"`
	RootItemType   string                `json:"rootItemType"`
	ItemCount      int                   `json:"itemCount"`
	BodyCount      int                   `json:"bodyCount"`
	ViewCount      int                   `json:"viewCount"`
	SourceSHA256   string                `json:"sourceSha256"`
	PlanSHA256     string                `json:"planSha256"`
	PlanByteLength int64                 `json:"planByteLength"`
}

type TemplateImportStageItem struct {
	SourceID       string          `json:"sourceId"`
	ParentSourceID *string         `json:"parentSourceId"`
	Sequence       string          `json:"seq"`
	Title          string          `json:"title"`
	ItemType       string          `json:"itemType"`
	Properties     json.RawMessage `json:"properties"`
	Schema         json.RawMessage `json:"schema"`
	Views          json.RawMessage `json:"views"`
	HasBody        bool            `json:"hasBody"`
}

type TemplateImportStageRequest struct {
	Profile TemplateImportProfile     `json:"profile"`
	Items   []TemplateImportStageItem `json:"items"`
}

type TemplateImportBodyWrite struct {
	SourceID     string `json:"sourceId"`
	TargetItemID string `json:"targetItemId"`
	ItemType     string `json:"itemType"`
}

type TemplateImportStage struct {
	ImportID     string                    `json:"importId"`
	OperationID  *string                   `json:"operationId"`
	TemplateID   string                    `json:"templateId"`
	StableKey    string                    `json:"stableKey"`
	Digest       string                    `json:"digest"`
	Unchanged    bool                      `json:"unchanged"`
	ItemMappings []TemplateImportBodyWrite `json:"itemMappings"`
	BodyWrites   []TemplateImportBodyWrite `json:"bodyWrites"`
}

type CompleteTemplateImportRequest struct {
	WrittenTargetItemIDs []string `json:"writtenTargetItemIds"`
}

type TemplateImportResult struct {
	ImportID             string   `json:"importId"`
	OperationID          *string  `json:"operationId"`
	TemplateID           string   `json:"templateId"`
	StableKey            string   `json:"stableKey"`
	Digest               string   `json:"digest"`
	Unchanged            bool     `json:"unchanged"`
	ItemCount            int      `json:"itemCount"`
	BodyCount            int      `json:"bodyCount"`
	WrittenTargetItemIDs []string `json:"writtenTargetItemIds"`
}

type ExportSource struct {
	ExportID          string    `json:"exportId"`
	Format            string    `json:"format"`
	SourceURL         string    `json:"sourceUrl"`
	BearerToken       string    `json:"bearerToken"`
	DelegationExpires time.Time `json:"delegationExpiresAt"`
}

type ExportDestination struct {
	ExportID          string    `json:"exportId"`
	AttemptID         string    `json:"attemptId"`
	Format            string    `json:"format"`
	ObjectKey         string    `json:"objectKey"`
	UploadURL         string    `json:"uploadUrl"`
	ReadURL           string    `json:"readUrl"`
	DeleteURL         string    `json:"deleteUrl"`
	CapabilityExpires time.Time `json:"capabilityExpiresAt"`
}

type ResponseError struct {
	Status int
	Path   string
}

func (err *ResponseError) Error() string {
	return fmt.Sprintf("worker API request to %s returned %d", err.Path, err.Status)
}

func (err *ResponseError) StatusCode() int { return err.Status }

func New(baseURL, secret, owner string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secret,
		owner:   owner,
		httpClient: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (client *Client) Ping(ctx context.Context) error {
	// A public liveness probe proves only that Nix.Api is listening. Readiness must also prove that
	// this worker's service credential is accepted and that the dispatch store is available. This
	// kind cannot be created by the job API, so the probe can never consume application work.
	jobs, err := client.LeaseJobs(ctx, "readiness.probe", 1)
	if err != nil {
		return fmt.Errorf("worker API dispatch probe failed: %w", err)
	}
	if len(jobs) != 0 {
		return errors.New("worker API dispatch probe returned an impossible job kind")
	}
	return nil
}

// GetIndexItemMetadata returns nil on the authoritative item-not-found response.
func (client *Client) GetIndexItemMetadata(ctx context.Context, tenantID, itemID string) (*IndexItemMetadata, error) {
	path := "/internal/worker-dispatch/index/items/" + url.PathEscape(tenantID) + "/" + url.PathEscape(itemID)
	request, err := client.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, &ResponseError{Status: response.StatusCode, Path: path}
	}
	if !hasMediaType(response.Header.Get("Content-Type"), "application/json") {
		return nil, errors.New("worker API index metadata is not JSON")
	}
	body, err := readBounded(response.Body, response.ContentLength, maxIndexMetadataBytes)
	if err != nil {
		return nil, err
	}
	var metadata IndexItemMetadata
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&metadata); err != nil {
		return nil, fmt.Errorf("decode worker API index metadata: %w", err)
	}
	if err := requireResponseEOF(decoder); err != nil {
		return nil, fmt.Errorf("decode worker API index metadata: %w", err)
	}
	return &metadata, nil
}

// GetIndexItemBody returns nil when the item disappeared between metadata and
// body hydration. A 204 response is represented by a non-nil empty string.
func (client *Client) GetIndexItemBody(ctx context.Context, tenantID, itemID string) (*string, error) {
	path := "/internal/worker-dispatch/index/items/" + url.PathEscape(tenantID) + "/" + url.PathEscape(itemID) + "/body"
	request, err := client.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/plain")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return nil, nil
	case http.StatusNoContent:
		empty := ""
		return &empty, nil
	case http.StatusOK:
	default:
		return nil, &ResponseError{Status: response.StatusCode, Path: path}
	}
	if !hasMediaType(response.Header.Get("Content-Type"), "text/plain") {
		return nil, errors.New("worker API index body is not plain text")
	}
	body, err := readBounded(response.Body, response.ContentLength, MaxIndexBodyBytes)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, errors.New("worker API index body is not valid UTF-8")
	}
	text := string(body)
	return &text, nil
}

func (client *Client) EnqueueIndexRebuild(ctx context.Context, request IndexRebuildRequest) (*IndexRebuildPage, error) {
	if (request.AfterTenantID == nil) != (request.AfterItemID == nil) || request.Limit != nil && (*request.Limit < 1 || *request.Limit > 1000) || request.AfterTenantID != nil && !canonicalUUID(*request.AfterTenantID) || request.AfterItemID != nil && !canonicalUUID(*request.AfterItemID) || request.UpdatedSince != nil && request.UpdatedSince.IsZero() {
		return nil, errors.New("index rebuild request is invalid")
	}
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	var page IndexRebuildPage
	if err := client.requestStrictJSON(ctx, http.MethodPost, "/internal/worker-dispatch/index/rebuild", bytes.NewReader(body), &page, 64<<10); err != nil {
		return nil, err
	}
	if page.Enqueued < 0 || page.HasMore && (page.NextTenantID == nil || page.NextItemID == nil || !canonicalUUID(*page.NextTenantID) || !canonicalUUID(*page.NextItemID)) {
		return nil, errors.New("worker API index rebuild response is invalid")
	}
	return &page, nil
}

func (client *Client) GetIndexStatus(ctx context.Context) (*IndexQueueStatus, error) {
	var status IndexQueueStatus
	if err := client.requestStrictJSON(ctx, http.MethodGet, "/internal/worker-dispatch/index/status", nil, &status, 64<<10); err != nil {
		return nil, err
	}
	if status.Pending < 0 || status.HighestAttempts < 0 || status.PendingFailures < 0 {
		return nil, errors.New("worker API index status is invalid")
	}
	return &status, nil
}

func (client *Client) PreparePluginEvent(ctx context.Context, event broker.WorkspaceEvent, leaseSeconds int) (pluginworker.Preparation, error) {
	if !canonicalUUID(event.MessageID) || !canonicalUUID(event.TenantID) || !canonicalUUID(event.WorkspaceID) || !canonicalUUID(event.ItemID) || leaseSeconds < 5 || leaseSeconds > 300 {
		return pluginworker.Preparation{}, errors.New("plugin event preparation request is invalid")
	}
	causationID := event.MessageID
	if event.CausationID != nil {
		causationID = *event.CausationID
	}
	body, err := json.Marshal(struct {
		TenantID         string `json:"tenantId"`
		WorkspaceID      string `json:"workspaceId"`
		ItemID           string `json:"itemId"`
		Kind             string `json:"kind"`
		AggregateVersion *int64 `json:"aggregateVersion,omitempty"`
		CausationID      string `json:"causationId"`
		CausationDepth   int    `json:"causationDepth"`
		LeaseSeconds     int    `json:"leaseSeconds"`
	}{event.TenantID, event.WorkspaceID, event.ItemID, event.Kind, event.AggregateVersion, causationID, event.CausationDepth, leaseSeconds})
	if err != nil {
		return pluginworker.Preparation{}, err
	}
	path := "/internal/worker-dispatch/plugins/events/" + url.PathEscape(event.MessageID) + "/prepare"
	var preparation pluginworker.Preparation
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &preparation, 512<<10); err != nil {
		return pluginworker.Preparation{}, err
	}
	switch preparation.Outcome {
	case "prepared":
		if len(preparation.Plans) == 0 || len(preparation.Plans) > 128 {
			return pluginworker.Preparation{}, errors.New("worker API plugin plans are invalid")
		}
	case "busy", "settled":
		if len(preparation.Plans) != 0 {
			return pluginworker.Preparation{}, errors.New("worker API plugin outcome contains unexpected plans")
		}
	default:
		return pluginworker.Preparation{}, errors.New("worker API plugin preparation outcome is invalid")
	}
	for _, plan := range preparation.Plans {
		if !canonicalUUID(plan.InvocationID) || !canonicalUUID(plan.InstallationID) || plan.Attempt < 1 || plan.Attempt > 5 || plan.LeaseUntil.IsZero() || plan.Component.ID == "" || plan.Component.Version == "" || len(plan.Component.PublicKey) != 32 || len(plan.Component.Signature) != 64 || plan.Component.ByteLength <= 0 || plan.Component.ByteLength > 8<<20 || plan.Component.DownloadURL == "" || plan.Component.DownloadExpiresAt.IsZero() {
			return pluginworker.Preparation{}, errors.New("worker API plugin invocation plan is invalid")
		}
	}
	return preparation, nil
}

func (client *Client) CallPluginHost(ctx context.Context, invocationID, capability string, payload json.RawMessage) (json.RawMessage, error) {
	if !canonicalUUID(invocationID) || capability == "" || len(capability) > 64 || len(payload) == 0 || len(payload) > 64<<10 || !json.Valid(payload) {
		return nil, errors.New("plugin host call request is invalid")
	}
	body, err := json.Marshal(struct {
		Capability string          `json:"capability"`
		Request    json.RawMessage `json:"request"`
	}{capability, payload})
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-dispatch/plugins/invocations/" + url.PathEscape(invocationID) + "/host-calls"
	var response struct {
		Result json.RawMessage `json:"result"`
	}
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &response, 256<<10); err != nil {
		return nil, err
	}
	if len(response.Result) == 0 || !json.Valid(response.Result) {
		return nil, errors.New("worker API plugin host response is invalid")
	}
	return append(json.RawMessage(nil), response.Result...), nil
}

func (client *Client) CompletePluginInvocation(ctx context.Context, invocationID string, completion pluginworker.Completion) (pluginworker.CompletionResult, error) {
	if !canonicalUUID(invocationID) {
		return pluginworker.CompletionResult{}, errors.New("plugin completion identity is invalid")
	}
	body, err := json.Marshal(completion)
	if err != nil {
		return pluginworker.CompletionResult{}, err
	}
	path := "/internal/worker-dispatch/plugins/invocations/" + url.PathEscape(invocationID) + "/complete"
	var result pluginworker.CompletionResult
	if err := client.requestStrictJSON(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 64<<10); err != nil {
		return pluginworker.CompletionResult{}, err
	}
	if result.Outcome != "applied" && result.Outcome != "replayed" {
		return pluginworker.CompletionResult{}, errors.New("worker API plugin completion outcome is invalid")
	}
	return result, nil
}

func (client *Client) LeaseJobs(ctx context.Context, kind string, limit int) ([]Job, error) {
	var jobs []Job
	if err := client.lease(ctx, "/internal/worker-dispatch/jobs/lease", kind, limit, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (client *Client) ClaimJob(ctx context.Context, id, executionID string, leaseSeconds int) (*Job, error) {
	body, err := json.Marshal(struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}{executionID, leaseSeconds})
	if err != nil {
		return nil, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/internal/worker-dispatch/jobs/"+id+"/claim", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker API claim returned %s", response.Status)
	}
	var job Job
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&job); err != nil {
		return nil, err
	}
	return &job, nil
}

func (client *Client) RenewJob(ctx context.Context, id, executionID string, leaseSeconds int) (bool, error) {
	body, err := json.Marshal(struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}{executionID, leaseSeconds})
	if err != nil {
		return false, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/internal/worker-dispatch/jobs/"+id+"/renew", strings.NewReader(string(body)))
	if err != nil {
		return false, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("worker API renewal returned %s", response.Status)
	}
	return true, nil
}

func (client *Client) JobState(ctx context.Context, id, executionID string) (*JobState, error) {
	path := "/internal/worker-dispatch/jobs/" + id + "/state?owner=" + url.QueryEscape(executionID)
	request, err := client.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker API state returned %s", response.Status)
	}
	var state JobState
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (client *Client) GetFileInspection(ctx context.Context, uploadID string) (*FileInspection, error) {
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID)
	var inspection FileInspection
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &inspection); err != nil {
		return nil, err
	}
	return &inspection, nil
}

func (client *Client) PublishFileInspection(ctx context.Context, uploadID string, inspected InspectedFile) (*PublishedFile, error) {
	body, err := json.Marshal(inspected)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID) + "/publish"
	var published PublishedFile
	if err := client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), &published); err != nil {
		return nil, err
	}
	return &published, nil
}

func (client *Client) RejectFileInspection(ctx context.Context, uploadID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/files/uploads/" + url.PathEscape(uploadID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetObjectCleanupCapability(ctx context.Context, offset int) (*ObjectCleanupCapability, error) {
	path := "/internal/worker-executions/object-cleanup?offset=" + url.QueryEscape(fmt.Sprint(offset))
	var capability ObjectCleanupCapability
	if err := client.requestJSONLimit(ctx, http.MethodGet, path, nil, &capability, 1<<20); err != nil {
		return nil, err
	}
	return &capability, nil
}

func (client *Client) GetDocumentImportPreview(ctx context.Context, importID string) (*DocumentImportPreview, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/preview"
	var preview DocumentImportPreview
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

func (client *Client) CompleteDocumentImportPreview(ctx context.Context, importID string, result CompleteDocumentImportPreview) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/preview/complete"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetDocumentImportCommit(ctx context.Context, importID string) (*DocumentImportCommit, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/commit"
	var commit DocumentImportCommit
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &commit); err != nil {
		return nil, err
	}
	return &commit, nil
}

func (client *Client) StageDocumentImport(ctx context.Context, importID string, stage DocumentImportStageRequest) (*DocumentImportStage, error) {
	body, err := json.Marshal(stage)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/stage"
	var result DocumentImportStage
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, strings.NewReader(string(body)), &result, 16<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) GetDocumentImportObjectCapability(ctx context.Context, importID, sourceID string) (*DocumentImportObjectCapability, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/objects/capability?sourceId=" + url.QueryEscape(sourceID)
	var capability DocumentImportObjectCapability
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &capability); err != nil {
		return nil, err
	}
	return &capability, nil
}

func (client *Client) CompleteDocumentImportObject(ctx context.Context, importID, sourceID string, byteLength int64, sha256 string) error {
	body, err := json.Marshal(struct {
		SourceID   string `json:"sourceId"`
		ByteLength int64  `json:"byteLength"`
		SHA256     string `json:"sha256"`
	}{sourceID, byteLength, sha256})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/objects/complete"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) FinalizeDocumentImport(ctx context.Context, importID string) (*DocumentImportResult, error) {
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/finalize"
	var result DocumentImportResult
	if err := client.requestJSON(ctx, http.MethodPost, path, http.NoBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) RejectDocumentImport(ctx context.Context, importID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/imports/" + url.PathEscape(importID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, strings.NewReader(string(body)), nil)
}

func (client *Client) GetTemplateImportPreview(ctx context.Context, importID string) (*TemplateImportPreview, error) {
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/preview"
	var preview TemplateImportPreview
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &preview); err != nil {
		return nil, err
	}
	return &preview, nil
}

func (client *Client) CompleteTemplateImportPreview(ctx context.Context, importID string, result CompleteTemplateImportPreview) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/preview/complete"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func (client *Client) GetTemplateImportCommit(ctx context.Context, importID string) (*TemplateImportCommit, error) {
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/commit"
	var commit TemplateImportCommit
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &commit); err != nil {
		return nil, err
	}
	return &commit, nil
}

func (client *Client) StageTemplateImport(ctx context.Context, importID string, stage TemplateImportStageRequest) (*TemplateImportStage, error) {
	body, err := json.Marshal(stage)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/stage"
	var result TemplateImportStage
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 16<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) CompleteTemplateImport(ctx context.Context, importID string, completion CompleteTemplateImportRequest) (*TemplateImportResult, error) {
	body, err := json.Marshal(completion)
	if err != nil {
		return nil, err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/complete"
	var result TemplateImportResult
	if err := client.requestJSONLimit(ctx, http.MethodPost, path, bytes.NewReader(body), &result, 1<<20); err != nil {
		return nil, err
	}
	return &result, nil
}

func (client *Client) RejectTemplateImport(ctx context.Context, importID, code string) error {
	body, err := json.Marshal(struct {
		Code string `json:"code"`
	}{code})
	if err != nil {
		return err
	}
	path := "/internal/worker-executions/template-imports/" + url.PathEscape(importID) + "/reject"
	return client.requestJSON(ctx, http.MethodPost, path, bytes.NewReader(body), nil)
}

func (client *Client) GetExportSource(ctx context.Context, exportID string) (*ExportSource, error) {
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID)
	var source ExportSource
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &source); err != nil {
		return nil, err
	}
	return &source, nil
}

func (client *Client) GetExportDestination(ctx context.Context, exportID string, byteLength int64, sha256 string) (*ExportDestination, error) {
	query := url.Values{}
	query.Set("byteLength", fmt.Sprint(byteLength))
	query.Set("sha256", sha256)
	path := "/internal/worker-executions/exports/" + url.PathEscape(exportID) + "/destination?" + query.Encode()
	var destination ExportDestination
	if err := client.requestJSON(ctx, http.MethodGet, path, nil, &destination); err != nil {
		return nil, err
	}
	return &destination, nil
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
	return client.requestJSON(ctx, http.MethodPost, path, body, nil)
}

func (client *Client) requestJSON(ctx context.Context, method, path string, body io.Reader, target any) error {
	return client.requestJSONLimit(ctx, method, path, body, target, 256<<10)
}

func (client *Client) requestJSONLimit(ctx context.Context, method, path string, body io.Reader, target any, responseLimit int64) error {
	request, err := client.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &ResponseError{Status: response.StatusCode, Path: path}
	}
	if target != nil {
		if responseLimit <= 0 {
			return errors.New("worker API response limit must be positive")
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, responseLimit)).Decode(target); err != nil {
			return err
		}
	}
	return nil
}

func (client *Client) requestStrictJSON(ctx context.Context, method, path string, body io.Reader, target any, responseLimit int64) error {
	request, err := client.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &ResponseError{Status: response.StatusCode, Path: path}
	}
	if !hasMediaType(response.Header.Get("Content-Type"), "application/json") {
		return errors.New("worker API response is not JSON")
	}
	responseBody, err := readBounded(response.Body, response.ContentLength, responseLimit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return requireResponseEOF(decoder)
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
	if execution, ok := ctx.Value(executionContextKey{}).(executionContext); ok {
		request.Header.Set("X-Nix-Worker-Job-Id", execution.jobID)
		request.Header.Set("X-Nix-Worker-Execution-Id", execution.executionID)
	}
	return request, nil
}

func readBounded(reader io.Reader, contentLength, limit int64) ([]byte, error) {
	if limit <= 0 || contentLength > limit {
		return nil, ErrResponseTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}

func hasMediaType(value, expected string) bool {
	mediaType, parameters, err := mime.ParseMediaType(value)
	if err != nil || !strings.EqualFold(mediaType, expected) {
		return false
	}
	charset := parameters["charset"]
	return charset == "" || strings.EqualFold(charset, "utf-8")
}

func requireResponseEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func canonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for position, character := range value {
		if position == 8 || position == 13 || position == 18 || position == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}
