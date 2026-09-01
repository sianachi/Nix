package indexer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const (
	maxTitleBytes         = 4 << 10
	maxItemTypeBytes      = 256
	maxPropertyTextBytes  = 32 << 10
	maxSourceVersionBytes = 128
	maxLifecycleBytes     = 128
	maxAncestors          = 256
	maxLinks              = 512
	maxAuthorizationKeys  = 1024
	maxPropertiesDepth    = 8
	maxPropertiesNodes    = 4096
	maxPropertyString     = 16 << 10
)

var (
	ErrPermanentEvent  = errors.New("permanent index event failure")
	ErrHydrationNeeded = errors.New("index event requires authoritative hydration")
)

type Hydrator interface {
	GetIndexItemMetadata(context.Context, string, string) (*workerapi.IndexItemMetadata, error)
	GetIndexItemBody(context.Context, string, string) (*string, error)
}

type Search interface {
	EnsureIndex(context.Context) error
	Apply(context.Context, opensearch.Mutation) (opensearch.ApplyResult, error)
}

type Processor struct {
	hydrator   Hydrator
	target     *index.Index
	search     Search
	logger     *slog.Logger
	maxOrders  int
	retryDelay time.Duration
	orderMu    sync.Mutex
	orders     map[string]opensearch.EventOrder
	state      *State
}

func NewProcessor(hydrator Hydrator, target *index.Index, search Search, maxOrders int, retryDelay time.Duration, state *State, logger *slog.Logger) (*Processor, error) {
	if target == nil || maxOrders <= 0 || retryDelay < 0 || state == nil || logger == nil {
		return nil, errors.New("index processor configuration is invalid")
	}
	return &Processor{hydrator: hydrator, target: target, search: search, logger: logger, maxOrders: maxOrders, retryDelay: retryDelay, orders: make(map[string]opensearch.EventOrder), state: state}, nil
}

func Run(ctx context.Context, client *broker.Client, hydrator Hydrator, target *index.Index, search Search, state *State, logger *slog.Logger, consumerName string, maxRecords int, retryInterval time.Duration) {
	if retryInterval <= 0 {
		retryInterval = time.Second
	}
	processor, err := NewProcessor(hydrator, target, search, maxRecords, min(retryInterval, 5*time.Second), state, logger)
	if err != nil {
		state.recordInitializationFailure(err)
		logger.Error("indexer configuration failed", "error", err)
		return
	}
	for ctx.Err() == nil {
		if search != nil {
			initializationContext, cancel := context.WithTimeout(ctx, min(retryInterval, 10*time.Second))
			err = search.EnsureIndex(initializationContext)
			cancel()
			if err != nil {
				state.recordInitializationFailure(err)
				logger.Error("OpenSearch index initialization failed", "error", err)
				if !wait(ctx, retryInterval) {
					return
				}
				continue
			}
		}
		state.recordInitialized()
		state.recordConsumerStarted()
		err = client.Consume(ctx, broker.IndexQueue, consumerName, 1, processor.Handle)
		state.recordConsumerStopped(err)
		if ctx.Err() != nil {
			return
		}
		logger.Error("index broker consumer stopped", "error", err)
		if !wait(ctx, retryInterval) {
			return
		}
	}
}

func (processor *Processor) Handle(ctx context.Context, envelope broker.Envelope) broker.DeliveryAction {
	processor.state.recordReceived()
	outcome, err := processor.Process(ctx, envelope)
	if err != nil {
		if errors.Is(err, ErrPermanentEvent) {
			processor.state.recordRejected(err)
			processor.logger.Warn("index event rejected", "message_id", envelope.MessageID, "kind", envelope.Kind, "error", err)
			return broker.Reject
		}
		processor.state.recordRequeued(err)
		processor.logger.Warn("index event requeued", "message_id", envelope.MessageID, "kind", envelope.Kind, "error", err)
		if processor.retryDelay > 0 {
			_ = wait(ctx, processor.retryDelay)
		}
		return broker.Requeue
	}
	processor.state.recordAcknowledged(outcome)
	return broker.Acknowledge
}

func (processor *Processor) Process(ctx context.Context, envelope broker.Envelope) (Outcome, error) {
	event, err := envelope.WorkspaceEvent()
	if err != nil {
		return Outcome{}, permanent("workspace event envelope is invalid", err)
	}
	legacy, hasLegacy, err := decodeEventPayload(event)
	if err != nil {
		return Outcome{}, err
	}
	mutation, usedLegacy, err := processor.mutation(ctx, event, legacy, hasLegacy)
	if err != nil {
		return Outcome{}, err
	}
	if event.AggregateVersion != nil {
		mutation.Document.SourceVersion = strconv.FormatInt(*event.AggregateVersion, 10)
	}
	if processor.search != nil {
		result, applyErr := processor.search.Apply(ctx, mutation)
		if applyErr != nil {
			if errors.Is(applyErr, opensearch.ErrInvalidMutation) {
				return Outcome{}, permanent("index mutation is invalid", applyErr)
			}
			var responseError *opensearch.ResponseError
			if errors.As(applyErr, &responseError) && !responseError.Retryable {
				return Outcome{}, permanent("OpenSearch refused the validated index mutation", applyErr)
			}
			return Outcome{}, fmt.Errorf("apply OpenSearch mutation: %w", applyErr)
		}
		if !result.Applied {
			return Outcome{Stale: true, UsedLegacyPayload: usedLegacy}, nil
		}
		fallbackDropped := processor.applyMemory(mutation) != nil
		return Outcome{Applied: true, Deleted: mutation.Deleted, UsedLegacyPayload: usedLegacy, FallbackDropped: fallbackDropped}, nil
	}
	return processor.applyMemoryOrdered(mutation, usedLegacy)
}

func (processor *Processor) mutation(ctx context.Context, event broker.WorkspaceEvent, legacy opensearch.Document, hasLegacy bool) (opensearch.Mutation, bool, error) {
	if event.Kind == "item.deleted" {
		return deletion(event), false, nil
	}
	if processor.hydrator == nil {
		if !hasLegacy {
			return opensearch.Mutation{}, false, ErrHydrationNeeded
		}
		return documentMutation(event, legacy)
	}
	metadata, err := processor.hydrator.GetIndexItemMetadata(ctx, event.TenantID, event.ItemID)
	if err != nil {
		if hasLegacy && legacyFallbackAllowed(err) {
			processor.logger.Warn("index hydration unavailable; using validated event document", "message_id", event.MessageID, "error", err)
			mutation, _, mutationErr := documentMutation(event, legacy)
			return mutation, true, mutationErr
		}
		return opensearch.Mutation{}, false, fmt.Errorf("hydrate index metadata: %w", err)
	}
	if metadata == nil {
		return deletion(event), false, nil
	}
	document := metadataDocument(*metadata)
	if document.TenantID != event.TenantID || document.WorkspaceID != event.WorkspaceID || document.ItemID != event.ItemID {
		return opensearch.Mutation{}, false, permanent("hydrated index document scope does not match its envelope", nil)
	}
	body, err := processor.hydrator.GetIndexItemBody(ctx, event.TenantID, event.ItemID)
	if err != nil {
		if hasLegacy && legacyFallbackAllowed(err) {
			processor.logger.Warn("index body hydration unavailable; using validated event document", "message_id", event.MessageID, "error", err)
			mutation, _, mutationErr := documentMutation(event, legacy)
			return mutation, true, mutationErr
		}
		return opensearch.Mutation{}, false, fmt.Errorf("hydrate index body: %w", err)
	}
	if body == nil {
		return deletion(event), false, nil
	}
	document.Body = *body
	mutation, _, err := documentMutation(event, document)
	return mutation, false, err
}

func documentMutation(event broker.WorkspaceEvent, document opensearch.Document) (opensearch.Mutation, bool, error) {
	updatedAt, err := validateDocument(event, &document)
	if err != nil {
		return opensearch.Mutation{}, false, err
	}
	return opensearch.Mutation{
		Document: document,
		Order: opensearch.EventOrder{
			AggregateVersion: event.AggregateVersion,
			Timestamp:        updatedAt,
			OccurredAt:       event.OccurredAt,
			EventID:          event.MessageID,
		},
	}, true, nil
}

func deletion(event broker.WorkspaceEvent) opensearch.Mutation {
	sourceVersion := "legacy"
	if event.AggregateVersion != nil {
		sourceVersion = strconv.FormatInt(*event.AggregateVersion, 10)
	}
	return opensearch.Mutation{
		Document: opensearch.Document{
			TenantID:        event.TenantID,
			WorkspaceID:     event.WorkspaceID,
			ItemID:          event.ItemID,
			Title:           "",
			SourceVersion:   sourceVersion,
			SourceUpdatedAt: event.OccurredAt.Format(time.RFC3339Nano),
		},
		Deleted: true,
		Order: opensearch.EventOrder{
			AggregateVersion: event.AggregateVersion,
			Timestamp:        event.OccurredAt,
			OccurredAt:       event.OccurredAt,
			EventID:          event.MessageID,
		},
	}
}

func decodeEventPayload(event broker.WorkspaceEvent) (opensearch.Document, bool, error) {
	trimmed := bytes.TrimSpace(event.Payload)
	if bytes.Equal(trimmed, []byte("{}")) {
		return opensearch.Document{}, false, nil
	}
	if event.Kind == "item.deleted" {
		return opensearch.Document{}, false, permanent("delete event payload must be empty", nil)
	}
	var document opensearch.Document
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return opensearch.Document{}, false, permanent("index event document is invalid", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return opensearch.Document{}, false, permanent("index event document contains trailing JSON", err)
	}
	if document.TenantID != "" && document.TenantID != event.TenantID || document.WorkspaceID != "" && document.WorkspaceID != event.WorkspaceID || document.ItemID != event.ItemID {
		return opensearch.Document{}, false, permanent("legacy index document scope does not match its envelope", nil)
	}
	return document, true, nil
}

func validateDocument(event broker.WorkspaceEvent, document *opensearch.Document) (time.Time, error) {
	if document.TenantID != "" && document.TenantID != event.TenantID || document.WorkspaceID != "" && document.WorkspaceID != event.WorkspaceID || document.ItemID != event.ItemID {
		return time.Time{}, permanent("index document scope does not match its envelope", nil)
	}
	document.TenantID = event.TenantID
	document.WorkspaceID = event.WorkspaceID
	if !validUUID(document.ItemID) || document.ParentID != "" && !validUUID(document.ParentID) || len(document.Type) == 0 || len(document.Type) > maxItemTypeBytes || !utf8.ValidString(document.Type) || len(document.Title) > maxTitleBytes || !utf8.ValidString(document.Title) || len(document.Body) > workerapi.MaxIndexBodyBytes || !utf8.ValidString(document.Body) || len(document.PropertyText) > maxPropertyTextBytes || !utf8.ValidString(document.PropertyText) || len(document.LifecycleState) > maxLifecycleBytes || len(document.SourceVersion) > maxSourceVersionBytes {
		return time.Time{}, permanent("index document fields exceed their contract", nil)
	}
	if document.SourceVersion == "" && event.AggregateVersion == nil {
		return time.Time{}, permanent("index document has no source version", nil)
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, document.SourceUpdatedAt)
	if err != nil || updatedAt.IsZero() {
		return time.Time{}, permanent("index document has an invalid source timestamp", err)
	}
	if err := validateStringList(document.AncestorIDs, maxAncestors, 128, true); err != nil {
		return time.Time{}, permanent("index ancestor identities are invalid", err)
	}
	if err := validateStringList(document.Links, maxLinks, 4096, false); err != nil {
		return time.Time{}, permanent("index links are invalid", err)
	}
	if err := validateStringList(document.AuthorizationKeys, maxAuthorizationKeys, 512, false); err != nil {
		return time.Time{}, permanent("index authorization filters are invalid", err)
	}
	nodes := 0
	if err := validatePropertyValue(document.Properties, 0, &nodes); err != nil {
		return time.Time{}, permanent("index properties are invalid", err)
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
	return updatedAt.UTC(), nil
}

func validateStringList(values []string, maxCount, maxBytes int, requireUUID bool) error {
	if len(values) > maxCount {
		return errors.New("list limit exceeded")
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" || len(value) > maxBytes || !utf8.ValidString(value) || requireUUID && !validUUID(value) {
			return errors.New("list member is invalid")
		}
		if _, exists := seen[value]; exists {
			return errors.New("list members must be unique")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validatePropertyValue(value any, depth int, nodes *int) error {
	if value == nil {
		return nil
	}
	if depth > maxPropertiesDepth {
		return errors.New("property depth limit exceeded")
	}
	(*nodes)++
	if *nodes > maxPropertiesNodes {
		return errors.New("property node limit exceeded")
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "" || len(key) > 256 || !utf8.ValidString(key) {
				return errors.New("property key is invalid")
			}
			if err := validatePropertyValue(child, depth+1, nodes); err != nil {
				return err
			}
		}
	case []any:
		if len(typed) > maxPropertiesNodes {
			return errors.New("property array limit exceeded")
		}
		for _, child := range typed {
			if err := validatePropertyValue(child, depth+1, nodes); err != nil {
				return err
			}
		}
	case string:
		if len(typed) > maxPropertyString || !utf8.ValidString(typed) {
			return errors.New("property string is invalid")
		}
	case bool, float64, json.Number:
	default:
		return fmt.Errorf("unsupported property value %T", value)
	}
	return nil
}

func metadataDocument(metadata workerapi.IndexItemMetadata) opensearch.Document {
	return opensearch.Document{
		TenantID: metadata.TenantID, WorkspaceID: metadata.WorkspaceID, ItemID: metadata.ItemID,
		ParentID: metadata.ParentID, Type: metadata.ItemType, AncestorIDs: metadata.AncestorIDs, Title: metadata.Title,
		PropertyText: metadata.PropertyText, Properties: metadata.Properties, Links: metadata.Links,
		AuthorizationKeys: metadata.AuthorizationKeys, LifecycleState: metadata.LifecycleState,
		Hidden: !metadata.Indexable, SourceUpdatedAt: metadata.SourceUpdatedAt,
	}
}

func legacyFallbackAllowed(err error) bool {
	var responseError *workerapi.ResponseError
	if errors.As(err, &responseError) {
		return responseError.Status == http.StatusRequestTimeout || responseError.Status == http.StatusTooEarly || responseError.Status == http.StatusTooManyRequests || responseError.Status >= 500
	}
	return true
}

func (processor *Processor) applyMemory(mutation opensearch.Mutation) error {
	if mutation.Deleted {
		processor.target.Remove(documentID(mutation.Document.TenantID, mutation.Document.ItemID))
		return nil
	}
	document := mutation.Document
	return processor.target.Put(stream.Record{ID: documentID(document.TenantID, document.ItemID), ParentID: document.ParentID, Title: document.Title, Body: document.Body + " " + document.PropertyText, Properties: document.Properties})
}

func (processor *Processor) applyMemoryOrdered(mutation opensearch.Mutation, usedLegacy bool) (Outcome, error) {
	key := documentID(mutation.Document.TenantID, mutation.Document.ItemID)
	processor.orderMu.Lock()
	defer processor.orderMu.Unlock()
	if current, exists := processor.orders[key]; exists && compareOrder(mutation.Order, current) <= 0 {
		return Outcome{Stale: true, UsedLegacyPayload: usedLegacy}, nil
	}
	if _, exists := processor.orders[key]; !exists && len(processor.orders) >= processor.maxOrders {
		return Outcome{}, index.ErrCapacityExceeded
	}
	if err := processor.applyMemory(mutation); err != nil {
		return Outcome{}, err
	}
	processor.orders[key] = mutation.Order
	return Outcome{Applied: true, Deleted: mutation.Deleted, UsedLegacyPayload: usedLegacy}, nil
}

func compareOrder(incoming, current opensearch.EventOrder) int {
	switch {
	case incoming.AggregateVersion != nil && current.AggregateVersion == nil:
		return 1
	case incoming.AggregateVersion == nil && current.AggregateVersion != nil:
		return -1
	case incoming.AggregateVersion != nil && current.AggregateVersion != nil:
		if *incoming.AggregateVersion < *current.AggregateVersion {
			return -1
		}
		if *incoming.AggregateVersion > *current.AggregateVersion {
			return 1
		}
	}
	if incoming.Timestamp.Before(current.Timestamp) {
		return -1
	}
	if incoming.Timestamp.After(current.Timestamp) {
		return 1
	}
	return strings.Compare(incoming.EventID, current.EventID)
}

func permanent(detail string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%w: %s", ErrPermanentEvent, detail)
	}
	return fmt.Errorf("%w: %s: %v", ErrPermanentEvent, detail, cause)
}

func validUUID(value string) bool {
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

func documentID(tenantID, itemID string) string { return tenantID + "_" + itemID }

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
