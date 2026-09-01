package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const (
	tenantID    = "20000000-0000-4000-8000-000000000002"
	workspaceID = "30000000-0000-4000-8000-000000000003"
	itemID      = "40000000-0000-4000-8000-000000000004"
	parentID    = "50000000-0000-4000-8000-000000000005"
)

func TestChangedEventHydratesAuthoritativeMetadataAndBodyBeforeAck(t *testing.T) {
	body := "authoritative body"
	hydrator := &fakeHydrator{
		metadata: metadata("Authoritative", "metadata-version"),
		body:     &body,
	}
	search := &fakeSearch{result: opensearch.ApplyResult{Applied: true}}
	processor := newProcessor(t, hydrator, search)
	version := int64(17)
	action := processor.Handle(context.Background(), envelope("item.changed", []byte(`{}`), &version, 1, time.Now().UTC()))

	if action != broker.Acknowledge || search.calls != 1 || search.mutation.Document.Body != body || search.mutation.Document.SourceVersion != "17" || search.mutation.Document.TenantID != tenantID || search.mutation.Document.AuthorizationKeys[0] != "principal:reader" {
		t.Fatalf("action = %v, calls = %d, mutation = %#v", action, search.calls, search.mutation)
	}
	if hydrator.metadataCalls != 1 || hydrator.bodyCalls != 1 {
		t.Fatalf("hydration calls = %d, %d", hydrator.metadataCalls, hydrator.bodyCalls)
	}
	health := processor.state.Snapshot()
	if health.Acknowledged != 1 || health.Applied != 1 || health.Requeued != 0 || health.Rejected != 0 {
		t.Fatalf("health = %#v", health)
	}
}

func TestPermissionChangedUsesTheSameAuthoritativeProjection(t *testing.T) {
	body := "body"
	search := &fakeSearch{result: opensearch.ApplyResult{Applied: true}}
	processor := newProcessor(t, &fakeHydrator{metadata: metadata("Permission refresh", "2"), body: &body}, search)
	version := int64(2)
	if action := processor.Handle(context.Background(), envelope("permission.changed", []byte(`{}`), &version, 1, time.Now().UTC())); action != broker.Acknowledge {
		t.Fatalf("action = %v", action)
	}
	if search.mutation.Document.Title != "Permission refresh" || search.mutation.Deleted {
		t.Fatalf("mutation = %#v", search.mutation)
	}
}

func TestMissingMetadataAndBodyBecomeVersionedDeletes(t *testing.T) {
	for name, hydrator := range map[string]*fakeHydrator{
		"metadata missing": {},
		"body race":        {metadata: metadata("Soon gone", "4"), body: nil},
	} {
		t.Run(name, func(t *testing.T) {
			search := &fakeSearch{result: opensearch.ApplyResult{Applied: true}}
			processor := newProcessor(t, hydrator, search)
			version := int64(4)
			if action := processor.Handle(context.Background(), envelope("item.changed", []byte(`{}`), &version, 1, time.Now().UTC())); action != broker.Acknowledge {
				t.Fatalf("action = %v", action)
			}
			if !search.mutation.Deleted || search.mutation.Document.ItemID != itemID || search.mutation.Document.SourceVersion != "4" {
				t.Fatalf("mutation = %#v", search.mutation)
			}
		})
	}
}

func TestDeleteDoesNotHydrateAndRequeuesTransientOpenSearchFailure(t *testing.T) {
	hydrator := &fakeHydrator{metadata: metadata("Must not load", "1")}
	search := &fakeSearch{err: &opensearch.ResponseError{Operation: "mutation", Status: http.StatusServiceUnavailable, Retryable: true}}
	processor := newProcessor(t, hydrator, search)
	version := int64(8)
	if action := processor.Handle(context.Background(), envelope("item.deleted", []byte(`{}`), &version, 1, time.Now().UTC())); action != broker.Requeue {
		t.Fatalf("action = %v", action)
	}
	if hydrator.metadataCalls != 0 || hydrator.bodyCalls != 0 || !search.mutation.Deleted {
		t.Fatalf("hydration = %d/%d, mutation = %#v", hydrator.metadataCalls, hydrator.bodyCalls, search.mutation)
	}
	if processor.state.Snapshot().Requeued != 1 {
		t.Fatalf("health = %#v", processor.state.Snapshot())
	}
}

func TestMalformedAndUnsupportedEventsAreRejected(t *testing.T) {
	processor := newProcessor(t, nil, nil)
	unknown := envelope("plugin.changed", []byte(`{}`), nil, 1, time.Now().UTC())
	badScopeDocument := document("Wrong", "1", time.Now().UTC())
	badScopeDocument.TenantID = "60000000-0000-4000-8000-000000000006"
	badPayload, _ := json.Marshal(badScopeDocument)

	for name, event := range map[string]broker.Envelope{
		"unsupported kind": unknown,
		"scope mismatch":   envelope("item.changed", badPayload, nil, 1, time.Now().UTC()),
		"unknown payload":  envelope("item.changed", []byte(`{"unexpected":true}`), nil, 1, time.Now().UTC()),
		"delete payload":   envelope("item.deleted", []byte(`{"item_id":"`+itemID+`"}`), nil, 1, time.Now().UTC()),
	} {
		t.Run(name, func(t *testing.T) {
			if action := processor.Handle(context.Background(), event); action != broker.Reject {
				t.Fatalf("action = %v", action)
			}
		})
	}
}

func TestHydrationMustEchoTheExactEnvelopeScope(t *testing.T) {
	scoped := metadata("Wrong tenant", "1")
	scoped.TenantID = "60000000-0000-4000-8000-000000000006"
	hydrator := &fakeHydrator{metadata: scoped}
	processor := newProcessor(t, hydrator, &fakeSearch{result: opensearch.ApplyResult{Applied: true}})
	if action := processor.Handle(context.Background(), envelope("item.changed", []byte(`{}`), nil, 1, time.Now().UTC())); action != broker.Reject {
		t.Fatalf("action = %v", action)
	}
	if hydrator.bodyCalls != 0 {
		t.Fatal("body hydration continued after a scope mismatch")
	}
}

func TestLegacyFullDocumentFallbackIsScopedAndUnavailableOnly(t *testing.T) {
	legacy := document("Legacy", "3", time.Now().UTC())
	payload, _ := json.Marshal(legacy)
	search := &fakeSearch{result: opensearch.ApplyResult{Applied: true}}
	processor := newProcessor(t, &fakeHydrator{metadataErr: errors.New("connection refused")}, search)
	if action := processor.Handle(context.Background(), envelope("item.changed", payload, nil, 1, time.Now().UTC())); action != broker.Acknowledge {
		t.Fatalf("action = %v", action)
	}
	if search.mutation.Document.TenantID != tenantID || search.mutation.Document.WorkspaceID != workspaceID || processor.state.Snapshot().LegacyFallbacks != 1 {
		t.Fatalf("mutation = %#v, health = %#v", search.mutation, processor.state.Snapshot())
	}

	for name, status := range map[string]int{"unauthorized": http.StatusUnauthorized, "bad request": http.StatusBadRequest} {
		t.Run(name, func(t *testing.T) {
			blockedSearch := &fakeSearch{result: opensearch.ApplyResult{Applied: true}}
			blocked := newProcessor(t, &fakeHydrator{metadataErr: &workerapi.ResponseError{Status: status, Path: "/metadata"}}, blockedSearch)
			if action := blocked.Handle(context.Background(), envelope("item.changed", payload, nil, 1, time.Now().UTC())); action != broker.Requeue {
				t.Fatalf("action = %v", action)
			}
			if blockedSearch.calls != 0 {
				t.Fatal("blocked hydration fell back to the event payload")
			}
		})
	}
}

func TestThinEventWithoutHydrationRequeues(t *testing.T) {
	processor := newProcessor(t, nil, &fakeSearch{result: opensearch.ApplyResult{Applied: true}})
	if action := processor.Handle(context.Background(), envelope("item.changed", []byte(`{}`), nil, 1, time.Now().UTC())); action != broker.Requeue {
		t.Fatalf("action = %v", action)
	}
}

func TestNonRetryableOpenSearchRefusalRejectsTheEvent(t *testing.T) {
	body := "body"
	search := &fakeSearch{err: &opensearch.ResponseError{Operation: "mutation", Status: http.StatusBadRequest}}
	processor := newProcessor(t, &fakeHydrator{metadata: metadata("Item", "1"), body: &body}, search)
	version := int64(1)
	if action := processor.Handle(context.Background(), envelope("item.changed", []byte(`{}`), &version, 1, time.Now().UTC())); action != broker.Reject {
		t.Fatalf("action = %v", action)
	}
}

func TestInMemoryFallbackRejectsOlderVersionsAndOldUnversionedEvents(t *testing.T) {
	processor := newProcessor(t, nil, nil)
	newerVersion := int64(2)
	olderVersion := int64(1)
	base := time.Now().UTC()
	newerPayload, _ := json.Marshal(document("Newer", "2", base.Add(time.Minute)))
	olderPayload, _ := json.Marshal(document("Older", "1", base))
	unversionedPayload, _ := json.Marshal(document("Legacy late", "legacy", base.Add(time.Hour)))

	for _, event := range []broker.Envelope{
		envelope("item.changed", newerPayload, &newerVersion, 2, base.Add(time.Minute)),
		envelope("item.changed", olderPayload, &olderVersion, 1, base),
		envelope("item.changed", unversionedPayload, nil, 3, base.Add(time.Hour)),
	} {
		if action := processor.Handle(context.Background(), event); action != broker.Acknowledge {
			t.Fatalf("action = %v", action)
		}
	}
	results := processor.target.Search("newer", 10)
	if len(results) != 1 || len(processor.target.Search("older", 10)) != 0 || len(processor.target.Search("legacy", 10)) != 0 || processor.state.Snapshot().Stale != 2 {
		t.Fatalf("results = %#v, health = %#v", results, processor.state.Snapshot())
	}
}

func FuzzIndexEventPayload(fuzz *testing.F) {
	valid, _ := json.Marshal(document("Valid", "1", time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)))
	fuzz.Add(valid)
	fuzz.Add([]byte(`{}`))
	fuzz.Add([]byte(`{"item_id":null}`))
	fuzz.Fuzz(func(t *testing.T, payload []byte) {
		processor := newProcessor(t, nil, nil)
		_ = processor.Handle(context.Background(), envelope("item.changed", payload, nil, 1, time.Now().UTC()))
	})
}

type fakeHydrator struct {
	metadata      *workerapi.IndexItemMetadata
	body          *string
	metadataErr   error
	bodyErr       error
	metadataCalls int
	bodyCalls     int
}

func (hydrator *fakeHydrator) GetIndexItemMetadata(context.Context, string, string) (*workerapi.IndexItemMetadata, error) {
	hydrator.metadataCalls++
	return hydrator.metadata, hydrator.metadataErr
}

func (hydrator *fakeHydrator) GetIndexItemBody(context.Context, string, string) (*string, error) {
	hydrator.bodyCalls++
	return hydrator.body, hydrator.bodyErr
}

type fakeSearch struct {
	result   opensearch.ApplyResult
	err      error
	mutation opensearch.Mutation
	calls    int
}

func (search *fakeSearch) EnsureIndex(context.Context) error { return nil }
func (search *fakeSearch) Apply(_ context.Context, mutation opensearch.Mutation) (opensearch.ApplyResult, error) {
	search.calls++
	search.mutation = mutation
	return search.result, search.err
}

func newProcessor(t *testing.T, hydrator Hydrator, search Search) *Processor {
	t.Helper()
	processor, err := NewProcessor(hydrator, index.New(100, 20), search, 20, 0, NewState(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return processor
}

func metadata(title, sourceVersion string) *workerapi.IndexItemMetadata {
	return &workerapi.IndexItemMetadata{
		TenantID: tenantID, WorkspaceID: workspaceID, ItemID: itemID, ParentID: parentID, ItemType: "note",
		AncestorIDs: []string{parentID}, Title: title, Properties: map[string]any{"status": "open"},
		Links: []string{"https://example.test"}, AuthorizationKeys: []string{"principal:reader"},
		LifecycleState: "active", Indexable: true, SourceUpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func document(title, sourceVersion string, updatedAt time.Time) opensearch.Document {
	return opensearch.Document{
		ItemID: itemID, ParentID: parentID, Type: "note", AncestorIDs: []string{parentID}, Title: title, Body: "body",
		Properties: map[string]any{"status": "open"}, Links: []string{"https://example.test"},
		AuthorizationKeys: []string{"principal:reader"}, LifecycleState: "active",
		SourceVersion: sourceVersion, SourceUpdatedAt: updatedAt.Format(time.RFC3339Nano),
	}
}

func envelope(kind string, payload []byte, version *int64, ordinal int, occurredAt time.Time) broker.Envelope {
	messageID := "10000000-0000-4000-8000-00000000000" + string(rune('0'+ordinal))
	workspace := workspaceID
	item := itemID
	return broker.Envelope{
		SchemaVersion: 1, MessageID: messageID, MessageType: broker.WorkspaceMessageType,
		OccurredAt: occurredAt, TenantID: tenantID, WorkspaceID: &workspace, ItemID: &item,
		Kind: kind, Payload: payload, CorrelationID: messageID, AggregateVersion: version,
	}
}
