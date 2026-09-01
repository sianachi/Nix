package broker

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	CommandsExchange     = "nix.commands.v1"
	ResultsExchange      = "nix.results.v1"
	WorkspaceExchange    = "nix.workspace.v1"
	CapabilitiesExchange = "nix.capabilities.v1"
	ImportQueue          = "nix.worker.import.v1"
	ExportQueue          = "nix.worker.export.v1"
	IndexQueue           = "nix.worker.index.v1"
	PluginEventsQueue    = "nix.worker.plugin-events.v1"
	ResultRoutingKey     = "job.result"
	CommandMessageType   = "worker.command.v1"
	ResultMessageType    = "worker.result.v1"
	WorkspaceMessageType = "workspace.event.v1"
	SchemaVersion        = 1
)

var ErrInvalidMessage = errors.New("invalid broker message")

type Envelope struct {
	SchemaVersion int             `json:"schemaVersion"`
	MessageID     string          `json:"messageId"`
	MessageType   string          `json:"messageType"`
	OccurredAt    time.Time       `json:"occurredAt"`
	TenantID      string          `json:"tenantId"`
	WorkspaceID   *string         `json:"workspaceId"`
	ItemID        *string         `json:"itemId"`
	Kind          string          `json:"kind"`
	Payload       json.RawMessage `json:"payload"`
	CorrelationID string          `json:"correlationId"`
	CausationID   *string         `json:"causationId,omitempty"`
	TraceParent   *string         `json:"traceParent,omitempty"`
}

type CommandReference struct {
	JobID string `json:"jobId"`
	Kind  string `json:"kind"`
}

type WorkerResult struct {
	SchemaVersion int             `json:"schemaVersion"`
	MessageID     string          `json:"messageId"`
	MessageType   string          `json:"messageType"`
	OccurredAt    time.Time       `json:"occurredAt"`
	JobID         string          `json:"jobId"`
	ExecutionID   string          `json:"executionId"`
	Succeeded     bool            `json:"succeeded"`
	Retryable     bool            `json:"retryable"`
	Result        json.RawMessage `json:"result,omitempty"`
	ErrorCode     *string         `json:"errorCode,omitempty"`
	ErrorDetail   *string         `json:"errorDetail,omitempty"`
	TraceParent   *string         `json:"traceParent,omitempty"`
}

type ExportFormatCapability struct {
	Format       string   `json:"format"`
	Label        string   `json:"label"`
	Extension    string   `json:"extension"`
	MediaType    string   `json:"mediaType"`
	Lossless     bool     `json:"lossless"`
	DeclaredLoss []string `json:"declaredLoss"`
}

type WorkerCapabilities struct {
	SchemaVersion int                      `json:"schemaVersion"`
	MessageID     string                   `json:"messageId"`
	MessageType   string                   `json:"messageType"`
	InstanceID    string                   `json:"instanceId"`
	Role          string                   `json:"role"`
	OccurredAt    time.Time                `json:"occurredAt"`
	ExpiresAt     time.Time                `json:"expiresAt"`
	ExportFormats []ExportFormatCapability `json:"exportFormats"`
}

func ParseEnvelope(body []byte, maxBytes int) (Envelope, error) {
	if len(body) == 0 || len(body) > maxBytes {
		return Envelope{}, ErrInvalidMessage
	}
	var envelope Envelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return Envelope{}, errors.Join(ErrInvalidMessage, err)
	}
	if envelope.SchemaVersion != SchemaVersion || envelope.MessageID == "" || envelope.MessageType == "" || envelope.Kind == "" || len(envelope.Payload) == 0 || envelope.OccurredAt.IsZero() {
		return Envelope{}, ErrInvalidMessage
	}
	return envelope, nil
}

func (envelope Envelope) Command() (CommandReference, error) {
	if envelope.MessageType != CommandMessageType {
		return CommandReference{}, ErrInvalidMessage
	}
	var command CommandReference
	if err := json.Unmarshal(envelope.Payload, &command); err != nil {
		return CommandReference{}, errors.Join(ErrInvalidMessage, err)
	}
	if command.JobID == "" || command.Kind == "" || command.Kind != envelope.Kind || envelope.CorrelationID != command.JobID {
		return CommandReference{}, ErrInvalidMessage
	}
	return command, nil
}
