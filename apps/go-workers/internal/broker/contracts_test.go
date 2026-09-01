package broker

import (
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	testMessageID   = "10000000-0000-4000-8000-000000000001"
	testTenantID    = "20000000-0000-4000-8000-000000000002"
	testWorkspaceID = "30000000-0000-4000-8000-000000000003"
	testItemID      = "40000000-0000-4000-8000-000000000004"
)

func TestCommandEnvelopeValidatesTheReference(t *testing.T) {
	body := []byte(`{"schemaVersion":1,"messageId":"` + testMessageID + `","messageType":"worker.command.v1","occurredAt":"2026-08-31T20:00:00Z","tenantId":"` + testTenantID + `","workspaceId":null,"itemId":null,"kind":"import.pdf","payload":{"jobId":"` + testMessageID + `","kind":"import.pdf"},"correlationId":"` + testMessageID + `"}`)
	envelope, err := ParseEnvelope(body, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	command, err := envelope.Command()
	if err != nil || command.JobID != testMessageID || command.Kind != "import.pdf" {
		t.Fatalf("unexpected command: %#v, %v", command, err)
	}
	if envelope.OccurredAt != time.Date(2026, 8, 31, 20, 0, 0, 0, time.UTC) {
		t.Fatalf("unexpected timestamp: %s", envelope.OccurredAt)
	}
}

func TestWorkspaceEnvelopeAcceptsOptionalAggregateVersion(t *testing.T) {
	body := workspaceBody(`{}`, `,"aggregateVersion":42`)
	envelope, err := ParseEnvelope([]byte(body), 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	event, err := envelope.WorkspaceEvent()
	if err != nil || event.AggregateVersion == nil || *event.AggregateVersion != 42 || event.ItemID != testItemID {
		t.Fatalf("workspace event = %#v, %v", event, err)
	}
}

func TestWorkspaceEnvelopeBoundsPluginCausationDepth(t *testing.T) {
	body := workspaceBody(`{}`, `,"causationId":"50000000-0000-4000-8000-000000000005","causationDepth":4`)
	envelope, err := ParseEnvelope([]byte(body), 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	event, err := envelope.WorkspaceEvent()
	if err != nil || event.CausationID == nil || event.CausationDepth != 4 {
		t.Fatalf("workspace event = %#v, %v", event, err)
	}
	for _, suffix := range []string{
		`,"causationDepth":1`,
		`,"causationId":"50000000-0000-4000-8000-000000000005"`,
		`,"causationId":"50000000-0000-4000-8000-000000000005","causationDepth":5`,
	} {
		if _, err := ParseEnvelope([]byte(workspaceBody(`{}`, suffix)), 64*1024); !errors.Is(err, ErrInvalidMessage) {
			t.Fatalf("suffix %s accepted: %v", suffix, err)
		}
	}
}

func TestWorkspaceEnvelopeRejectsUnsupportedKindsAndScope(t *testing.T) {
	for name, body := range map[string]string{
		"unsupported":  strings.Replace(workspaceBody(`{}`, ``), "item.changed", "plugin.changed", 1),
		"bad tenant":   strings.Replace(workspaceBody(`{}`, ``), testTenantID, "tenant", 1),
		"no workspace": strings.Replace(workspaceBody(`{}`, ``), `"`+testWorkspaceID+`"`, "null", 1),
		"bad routing":  strings.Replace(workspaceBody(`{}`, ``), `"correlationId":"`+testMessageID+`"`, `"correlationId":"`+testItemID+`"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			envelope, err := ParseEnvelope([]byte(body), 64*1024)
			if err == nil {
				_, err = envelope.WorkspaceEvent()
			}
			if !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("expected invalid message, got %v", err)
			}
		})
	}
}

func TestEnvelopeRefusesUnknownDuplicateDeepAndOversizedMessages(t *testing.T) {
	cases := [][]byte{
		[]byte(strings.Replace(workspaceBody(`{}`, ``), `"schemaVersion":1`, `"schemaVersion":1,"unknown":true`, 1)),
		[]byte(strings.Replace(workspaceBody(`{}`, ``), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1)),
		[]byte(workspaceBody(strings.Repeat(`{"nested":`, 13)+`null`+strings.Repeat(`}`, 13), ``)),
		make([]byte, 65),
	}
	limits := []int{64 * 1024, 64 * 1024, 64 * 1024, 64}
	for position, body := range cases {
		if _, err := ParseEnvelope(body, limits[position]); !errors.Is(err, ErrInvalidMessage) {
			t.Fatalf("case %d: expected invalid message, got %v", position, err)
		}
	}
}

func FuzzParseWorkspaceEnvelope(fuzz *testing.F) {
	fuzz.Add([]byte(workspaceBody(`{}`, `,"aggregateVersion":1`)))
	fuzz.Add([]byte(`{}`))
	fuzz.Add([]byte(`{"schemaVersion":1,"payload":{}}`))
	fuzz.Fuzz(func(t *testing.T, body []byte) {
		envelope, err := ParseEnvelope(body, 64*1024)
		if err == nil && envelope.MessageType == WorkspaceMessageType {
			_, _ = envelope.WorkspaceEvent()
		}
	})
}

func workspaceBody(payload, suffix string) string {
	return `{"schemaVersion":1,"messageId":"` + testMessageID + `","messageType":"workspace.event.v1","occurredAt":"2026-08-31T20:00:00Z","tenantId":"` + testTenantID + `","workspaceId":"` + testWorkspaceID + `","itemId":"` + testItemID + `","kind":"item.changed","payload":` + payload + `,"correlationId":"` + testMessageID + `"` + suffix + `}`
}
