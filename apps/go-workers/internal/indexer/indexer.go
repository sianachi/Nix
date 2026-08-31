package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var eventKinds = []string{"item.changed", "item.deleted", "permission.changed"}

func Run(ctx context.Context, client *workerapi.Client, target *index.Index, searchClient *opensearch.Client, logger *slog.Logger, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	ready := searchClient == nil
	poll := func() {
		if !ready {
			if err := searchClient.EnsureIndex(ctx); err != nil {
				logger.Error("OpenSearch index initialization failed", "error", err)
				return
			}
			ready = true
		}
		for _, kind := range eventKinds {
			events, err := client.LeaseOutbox(ctx, kind, 50)
			if err != nil {
				logger.Error("indexer lease failed", "kind", kind, "error", err)
				continue
			}
			for _, event := range events {
				if err := Process(ctx, event, target, searchClient); err != nil {
					if finishErr := client.FailOutbox(ctx, event.ID, err.Error()); finishErr != nil {
						logger.Error("indexer failure could not be recorded", "event_id", event.ID, "error", finishErr)
					}
					continue
				}
				if err := client.AcknowledgeOutbox(ctx, event.ID); err != nil {
					logger.Error("indexer acknowledgement failed", "event_id", event.ID, "error", err)
				}
			}
		}
	}
	poll()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			poll()
		}
	}
}

func Process(ctx context.Context, event workerapi.OutboxEvent, target *index.Index, searchClient *opensearch.Client) error {
	if event.TenantID == "" {
		return errors.New("index event has no tenant identity")
	}
	itemID := value(event.ItemID)
	if event.Kind == "item.deleted" {
		if itemID == "" {
			return errors.New("delete event has no item identity")
		}
		target.Remove(documentID(event.TenantID, itemID))
		if searchClient != nil {
			return searchClient.Delete(ctx, event.TenantID, itemID)
		}
		return nil
	}
	var document opensearch.Document
	if err := json.Unmarshal(event.Payload, &document); err != nil {
		return errors.New("invalid index event payload")
	}
	if document.ItemID == "" {
		var legacy stream.Record
		if err := json.Unmarshal(event.Payload, &legacy); err != nil {
			return errors.New("invalid index event payload")
		}
		document.ItemID, document.ParentID, document.Title, document.Body, document.Properties = legacy.ID, legacy.ParentID, legacy.Title, legacy.Body, legacy.Properties
	}
	if itemID != "" && document.ItemID != "" && itemID != document.ItemID {
		return errors.New("index payload item does not match event envelope")
	}
	document.TenantID = event.TenantID
	if event.WorkspaceID != nil {
		document.WorkspaceID = *event.WorkspaceID
	}
	if document.ItemID == "" || document.Title == "" {
		return errors.New("index document requires item identity and title")
	}
	record := stream.Record{ID: documentID(document.TenantID, document.ItemID), ParentID: document.ParentID, Title: document.Title, Body: document.Body + " " + document.PropertyText, Properties: document.Properties}
	if err := target.Put(record); err != nil {
		return err
	}
	if searchClient != nil {
		return searchClient.UpsertDocument(ctx, document)
	}
	return nil
}

func documentID(tenantID, itemID string) string { return tenantID + "_" + itemID }

func value(pointer *string) string {
	if pointer == nil {
		return ""
	}
	return *pointer
}
