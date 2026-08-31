package broker

import (
	"errors"
	"testing"
	"time"
)

func TestCommandEnvelopeValidatesTheReference(t *testing.T) {
	body := []byte(`{"schemaVersion":1,"messageId":"m1","messageType":"worker.command.v1","occurredAt":"2026-08-31T20:00:00Z","tenantId":"t1","workspaceId":null,"itemId":null,"kind":"import.pdf","payload":{"jobId":"j1","kind":"import.pdf"},"correlationId":"j1"}`)
	envelope, err := ParseEnvelope(body, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	command, err := envelope.Command()
	if err != nil || command.JobID != "j1" || command.Kind != "import.pdf" {
		t.Fatalf("unexpected command: %#v, %v", command, err)
	}
	if envelope.OccurredAt != time.Date(2026, 8, 31, 20, 0, 0, 0, time.UTC) {
		t.Fatalf("unexpected timestamp: %s", envelope.OccurredAt)
	}
}

func TestCommandEnvelopeRejectsRoutingMismatch(t *testing.T) {
	body := []byte(`{"schemaVersion":1,"messageId":"m1","messageType":"worker.command.v1","occurredAt":"2026-08-31T20:00:00Z","tenantId":"t1","kind":"export.pdf","payload":{"jobId":"j1","kind":"import.pdf"},"correlationId":"j1"}`)
	envelope, err := ParseEnvelope(body, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := envelope.Command(); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("expected invalid message, got %v", err)
	}
}

func TestEnvelopeRefusesOversizedMessages(t *testing.T) {
	if _, err := ParseEnvelope(make([]byte, 65), 64); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("expected invalid message, got %v", err)
	}
}
