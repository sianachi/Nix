package indexer

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func Run(ctx context.Context, client *workerapi.Client, target *index.Index, searchClient *opensearch.Client, logger *slog.Logger, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events, err := client.LeaseOutbox(ctx, "item.changed", 50)
			if err != nil {
				logger.Error("indexer lease failed", "error", err)
				continue
			}
			for _, event := range events {
				var record stream.Record
				if err := json.Unmarshal(event.Payload, &record); err != nil {
					_ = client.FailOutbox(ctx, event.ID, "invalid event payload")
					continue
				}
				if err := target.Put(record); err != nil {
					_ = client.FailOutbox(ctx, event.ID, err.Error())
					continue
				}
				if searchClient != nil {
					if err := searchClient.Upsert(ctx, record); err != nil {
						_ = client.FailOutbox(ctx, event.ID, err.Error())
						continue
					}
				}
				if err := client.AcknowledgeOutbox(ctx, event.ID); err != nil {
					logger.Error("indexer acknowledgement failed", "event_id", event.ID, "error", err)
					continue
				}
			}
		}
	}
}
