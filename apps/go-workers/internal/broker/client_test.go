package broker

import (
	"context"
	"testing"
	"time"
)

func TestConsumerReadinessTracksEveryActiveSlot(t *testing.T) {
	client := &Client{activeConsumers: make(map[string]int)}

	if client.ConsumerReady(ImportQueue) {
		t.Fatal("queue was ready before a consumer was accepted")
	}
	client.consumerStarted(ImportQueue)
	client.consumerStarted(ImportQueue)
	if !client.ConsumerReady(ImportQueue) {
		t.Fatal("queue was not ready with active consumers")
	}
	if client.ConsumerReady(ExportQueue) {
		t.Fatal("one queue made an unrelated queue ready")
	}
	client.consumerStopped(ImportQueue)
	if !client.ConsumerReady(ImportQueue) {
		t.Fatal("one stopped slot hid another active consumer")
	}
	client.consumerStopped(ImportQueue)
	if client.ConsumerReady(ImportQueue) {
		t.Fatal("queue remained ready after its last consumer stopped")
	}
}

func TestRequeueBackoffIsShortBoundedAndCancellable(t *testing.T) {
	if requeueBackoff < 100*time.Millisecond || requeueBackoff > 2*time.Second {
		t.Fatalf("requeue backoff is outside the short bounded range: %s", requeueBackoff)
	}

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	started := time.Now()
	if waitBeforeRequeue(ctx, requeueBackoff) {
		t.Fatal("cancelled requeue wait completed as ready")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelled requeue wait took too long: %s", elapsed)
	}

	if !waitBeforeRequeue(t.Context(), time.Millisecond) {
		t.Fatal("live requeue wait was cancelled")
	}
}
