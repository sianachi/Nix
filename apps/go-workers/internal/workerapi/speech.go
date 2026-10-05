package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// The speech role's contracts with Core (ADR-0059).
//
// Interactive requests (speaking, dictation) arrive from a browser carrying a capability Core
// issued. The worker cannot read it; it hands it back to Core, which says whose it is. Meeting
// transcription is an ordinary leased job, kind transcribe.audio, and its routes live under
// /internal/worker-executions/transcriptions/ bound to the execution like every other job's.

// SpeechPurpose is what a capability may be used for.
type SpeechPurpose string

const (
	SpeechSynthesize SpeechPurpose = "synthesize"
	SpeechDictate    SpeechPurpose = "dictate"
)

// SpeechGrant is what Core says about a capability it recognises.
type SpeechGrant struct {
	TenantID    string    `json:"tenantId"`
	PrincipalID string    `json:"principalId"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// ErrSpeechCapabilityRefused is a capability Core does not recognise for the purpose asked.
var ErrSpeechCapabilityRefused = errors.New("the speech capability was refused")

// RedeemSpeechCapability asks Core whose capability this is and whether it covers the purpose.
func (client *Client) RedeemSpeechCapability(ctx context.Context, token string, purpose SpeechPurpose) (*SpeechGrant, error) {
	body, err := json.Marshal(struct {
		Token   string        `json:"token"`
		Purpose SpeechPurpose `json:"purpose"`
	}{token, purpose})
	if err != nil {
		return nil, err
	}
	var grant SpeechGrant
	if err := client.requestJSON(ctx, http.MethodPost, "/internal/worker-dispatch/speech/capabilities/redeem", bytes.NewReader(body), &grant); err != nil {
		var response *ResponseError
		// Only Core saying "not this capability" is a refusal. A 401 or a 404 here is Core not
		// accepting the worker itself, which is a misconfiguration and must look like one.
		if errors.As(err, &response) && (response.Status == http.StatusForbidden || response.Status == http.StatusBadRequest) {
			return nil, ErrSpeechCapabilityRefused
		}
		return nil, err
	}
	if grant.TenantID == "" || grant.PrincipalID == "" || grant.ExpiresAt.IsZero() {
		return nil, errors.New("worker API speech grant is incomplete")
	}
	return &grant, nil
}

// TranscriptionPayload is the transcribe.audio job payload.
type TranscriptionPayload struct {
	AudioItemID string `json:"audioItemId"`
	NoteItemID  string `json:"noteItemId"`
	// Speakers is "channels" for a recording made by Nix with the microphone and the shared audio
	// on separate channels, and "none" for anything else.
	Speakers string `json:"speakers"`
}

// TranscriptionSource is where the audio is and what the job is for.
type TranscriptionSource struct {
	SourceURL   string `json:"sourceUrl"`
	ByteLength  int64  `json:"byteLength"`
	AudioItemID string `json:"audioItemId"`
	NoteItemID  string `json:"noteItemId"`
	WorkspaceID string `json:"workspaceId"`
	Speakers    string `json:"speakers"`
}

// GetTranscriptionSource returns a short-lived download capability for the leased job's audio.
func (client *Client) GetTranscriptionSource(ctx context.Context) (*TranscriptionSource, error) {
	var source TranscriptionSource
	if err := client.requestJSON(ctx, http.MethodGet, "/internal/worker-executions/transcriptions/source", nil, &source); err != nil {
		return nil, err
	}
	if source.SourceURL == "" || source.ByteLength <= 0 || source.AudioItemID == "" || source.NoteItemID == "" {
		return nil, errors.New("worker API transcription source is incomplete")
	}
	return &source, nil
}

// ReportTranscriptionProgress tells Core how far the leased job has got, as a whole percentage.
func (client *Client) ReportTranscriptionProgress(ctx context.Context, percent int) error {
	body, err := json.Marshal(struct {
		Percent int `json:"percent"`
	}{min(max(percent, 0), 100)})
	if err != nil {
		return err
	}
	return client.requestJSON(ctx, http.MethodPost, "/internal/worker-executions/transcriptions/progress", bytes.NewReader(body), nil)
}
