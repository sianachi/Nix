package pluginworker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginruntime"
)

const maxFailureDetailBytes = 512

type ComponentPlan struct {
	PublisherID       string    `json:"publisherId"`
	ID                string    `json:"id"`
	Version           string    `json:"version"`
	SHA256            string    `json:"sha256"`
	PublicKey         []byte    `json:"publicKey"`
	Signature         []byte    `json:"signature"`
	DownloadURL       string    `json:"downloadUrl"`
	DownloadExpiresAt time.Time `json:"downloadExpiresAt"`
	ByteLength        int64     `json:"byteLength"`
}

type InvocationPlan struct {
	InvocationID   string        `json:"invocationId"`
	InstallationID string        `json:"installationId"`
	Attempt        int           `json:"attempt"`
	LeaseUntil     time.Time     `json:"leaseUntil"`
	Component      ComponentPlan `json:"component"`
	Capabilities   []string      `json:"capabilities"`
}

type Completion struct {
	Succeeded   bool   `json:"succeeded"`
	Retryable   bool   `json:"retryable"`
	ErrorCode   string `json:"errorCode,omitempty"`
	ErrorDetail string `json:"errorDetail,omitempty"`
}

type Preparation struct {
	Outcome string           `json:"outcome"`
	Plans   []InvocationPlan `json:"plans"`
}

type CompletionResult struct {
	Outcome       string `json:"outcome"`
	ShouldRequeue bool   `json:"shouldRequeue"`
}

type API interface {
	PreparePluginEvent(context.Context, broker.WorkspaceEvent, int) (Preparation, error)
	CallPluginHost(context.Context, string, string, json.RawMessage) (json.RawMessage, error)
	CompletePluginInvocation(context.Context, string, Completion) (CompletionResult, error)
}

type Worker struct {
	api            API
	transfer       *objecttransfer.Client
	runtime        *pluginruntime.Runtime
	maxModuleBytes int64
	leaseSeconds   int
	retryDelay     time.Duration
	logger         *slog.Logger
}

func New(api API, transfer *objecttransfer.Client, runtime *pluginruntime.Runtime, maxModuleBytes int64, leaseDuration, retryDelay time.Duration, logger *slog.Logger) (*Worker, error) {
	leaseSeconds := int(leaseDuration / time.Second)
	if api == nil || transfer == nil || runtime == nil || maxModuleBytes <= 0 || maxModuleBytes > 32<<20 || leaseDuration%time.Second != 0 || leaseSeconds < 5 || leaseSeconds > 300 || retryDelay <= 0 || retryDelay > 30*time.Second || logger == nil {
		return nil, errors.New("plugin worker configuration is invalid")
	}
	return &Worker{api: api, transfer: transfer, runtime: runtime, maxModuleBytes: maxModuleBytes, leaseSeconds: leaseSeconds, retryDelay: retryDelay, logger: logger}, nil
}

func (worker *Worker) Handle(ctx context.Context, envelope broker.Envelope) broker.DeliveryAction {
	event, err := envelope.WorkspaceEvent()
	if err != nil {
		return broker.Reject
	}
	preparation, err := worker.api.PreparePluginEvent(ctx, event, worker.leaseSeconds)
	if err != nil {
		worker.logger.Warn("plugin event preparation failed", "event_id", event.MessageID, "error", err)
		return retryAction(err)
	}
	switch preparation.Outcome {
	case "busy":
		worker.waitForRetry(ctx)
		return broker.Requeue
	case "settled":
		return broker.Acknowledge
	case "prepared":
	default:
		return broker.Reject
	}
	plans := preparation.Plans
	if len(plans) == 0 || len(plans) > 128 {
		return broker.Reject
	}
	invocationIDs := make(map[string]struct{}, len(plans))
	for _, plan := range plans {
		if plan.InvocationID == "" {
			return broker.Reject
		}
		if _, duplicate := invocationIDs[plan.InvocationID]; duplicate {
			return broker.Reject
		}
		invocationIDs[plan.InvocationID] = struct{}{}
	}
	eventBody, err := marshalEvent(event)
	if err != nil {
		return broker.Reject
	}
	shouldRequeue := false
	for _, plan := range plans {
		switch worker.execute(ctx, event, eventBody, plan) {
		case broker.Acknowledge:
		case broker.Requeue:
			shouldRequeue = true
		case broker.Reject:
			return broker.Reject
		}
	}
	if shouldRequeue {
		worker.waitForRetry(ctx)
		return broker.Requeue
	}
	return broker.Acknowledge
}

func (worker *Worker) execute(ctx context.Context, event broker.WorkspaceEvent, eventBody json.RawMessage, plan InvocationPlan) broker.DeliveryAction {
	if plan.InvocationID == "" || plan.InstallationID == "" || plan.Attempt < 1 || plan.Attempt > 5 || plan.LeaseUntil.IsZero() ||
		plan.Component.PublisherID == "" || !strings.HasPrefix(plan.Component.ID, plan.Component.PublisherID+"/") ||
		plan.Component.DownloadURL == "" || plan.Component.DownloadExpiresAt.IsZero() || plan.Component.ByteLength <= 0 || plan.Component.ByteLength > worker.maxModuleBytes {
		return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{ErrorCode: "plugin.plan_invalid", ErrorDetail: "The invocation plan was invalid."})
	}
	download, err := worker.transfer.Download(ctx, plan.Component.DownloadURL, worker.maxModuleBytes)
	if err != nil {
		worker.logger.Warn("plugin component download failed", "event_id", event.MessageID, "invocation_id", plan.InvocationID, "error", err)
		return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{
			Retryable:   true,
			ErrorCode:   "plugin.component_unavailable",
			ErrorDetail: "The immutable plugin component could not be downloaded.",
		})
	}
	wasm, readErr := io.ReadAll(download.Body)
	closeErr := download.Body.Close()
	if readErr != nil || closeErr != nil || int64(len(wasm)) != plan.Component.ByteLength {
		worker.logger.Warn("plugin component transfer was incomplete", "event_id", event.MessageID, "invocation_id", plan.InvocationID)
		return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{
			Retryable:   true,
			ErrorCode:   "plugin.component_incomplete",
			ErrorDetail: "The immutable plugin component transfer was incomplete.",
		})
	}
	if err := objecttransfer.VerifyDigest(download.Digest, plan.Component.SHA256); err != nil {
		return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{ErrorCode: "plugin.component_digest_invalid", ErrorDetail: "The immutable component digest did not match."})
	}

	invocation := pluginruntime.Invocation{
		InstallationID: plan.InstallationID,
		EventID:        event.MessageID,
		Component: pluginruntime.Component{
			ID:        plan.Component.ID,
			Version:   plan.Component.Version,
			SHA256:    plan.Component.SHA256,
			PublicKey: append([]byte(nil), plan.Component.PublicKey...),
			Signature: append([]byte(nil), plan.Component.Signature...),
			Wasm:      wasm,
		},
		Event:        eventBody,
		Capabilities: append([]string(nil), plan.Capabilities...),
	}
	host := invocationHost{api: worker.api, invocationID: plan.InvocationID}
	if err := worker.runtime.Execute(ctx, invocation, host); err != nil {
		if ctx.Err() != nil || transientHostFailure(err) {
			return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{
				Retryable:   true,
				ErrorCode:   "plugin.dependency_unavailable",
				ErrorDetail: "A required plugin host capability was temporarily unavailable.",
			})
		}
		code := "plugin.execution_failed"
		if errors.Is(err, pluginruntime.ErrInvalidPlugin) {
			code = "plugin.component_invalid"
		}
		return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{
			ErrorCode:   code,
			ErrorDetail: boundedDetail(err),
		})
	}
	return worker.complete(ctx, event.MessageID, plan.InvocationID, Completion{Succeeded: true})
}

func (worker *Worker) waitForRetry(ctx context.Context) {
	timer := time.NewTimer(worker.retryDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func transientHostFailure(err error) bool {
	var response statusError
	if errors.As(err, &response) {
		status := response.StatusCode()
		return status == 408 || status == 429 || status >= 500
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func (worker *Worker) complete(ctx context.Context, eventID, invocationID string, completion Completion) broker.DeliveryAction {
	if invocationID == "" {
		return broker.Reject
	}
	result, err := worker.api.CompletePluginInvocation(ctx, invocationID, completion)
	if err != nil {
		worker.logger.Warn("plugin invocation completion failed", "event_id", eventID, "invocation_id", invocationID, "error", err)
		return retryAction(err)
	}
	if result.ShouldRequeue {
		return broker.Requeue
	}
	if result.Outcome != "applied" && result.Outcome != "replayed" {
		return broker.Reject
	}
	return broker.Acknowledge
}

type invocationHost struct {
	api          API
	invocationID string
}

func (host invocationHost) Call(ctx context.Context, _, _ string, capability string, request json.RawMessage) (json.RawMessage, error) {
	return host.api.CallPluginHost(ctx, host.invocationID, capability, request)
}

type statusError interface{ StatusCode() int }

func retryAction(err error) broker.DeliveryAction {
	var response statusError
	if errors.As(err, &response) && response.StatusCode() >= 400 && response.StatusCode() < 500 && response.StatusCode() != 408 && response.StatusCode() != 429 {
		return broker.Reject
	}
	return broker.Requeue
}

func boundedDetail(err error) string {
	detail := "The plugin could not process this event."
	if errors.Is(err, context.DeadlineExceeded) {
		detail = "The plugin exceeded its execution deadline."
	} else if errors.Is(err, pluginruntime.ErrInvalidPlugin) {
		detail = "The signed WebAssembly component did not satisfy the Nix plugin contract."
	}
	if len(detail) > maxFailureDetailBytes {
		return detail[:maxFailureDetailBytes]
	}
	return detail
}

func marshalEvent(event broker.WorkspaceEvent) (json.RawMessage, error) {
	return json.Marshal(struct {
		SchemaVersion    int     `json:"schemaVersion"`
		EventID          string  `json:"eventId"`
		OccurredAt       string  `json:"occurredAt"`
		TenantID         string  `json:"tenantId"`
		WorkspaceID      string  `json:"workspaceId"`
		ItemID           string  `json:"itemId"`
		Kind             string  `json:"kind"`
		AggregateVersion *int64  `json:"aggregateVersion,omitempty"`
		CausationID      *string `json:"causationId,omitempty"`
		CausationDepth   int     `json:"causationDepth"`
	}{
		SchemaVersion:    1,
		EventID:          event.MessageID,
		OccurredAt:       event.OccurredAt.UTC().Format(time.RFC3339Nano),
		TenantID:         event.TenantID,
		WorkspaceID:      event.WorkspaceID,
		ItemID:           event.ItemID,
		Kind:             event.Kind,
		AggregateVersion: event.AggregateVersion,
		CausationID:      event.CausationID,
		CausationDepth:   event.CausationDepth,
	})
}
