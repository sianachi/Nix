// Package speechhttp serves the two things a browser asks the speech role for directly: speech
// from text, and text from a short dictated clip.
//
// These are the only routes in the worker a browser reaches, so they do not trust the internal
// secret that guards the rest. Every request carries a capability Core issued to one person for
// one purpose; the worker cannot read it and asks Core whose it is. What a person says or has
// read aloud is neither stored nor logged here.
package speechhttp

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/speechaudio"
	"github.com/sianachi/Nix/apps/go-workers/internal/speechcmd"
	"github.com/sianachi/Nix/apps/go-workers/internal/tts"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

// Redeemer asks Core whose capability a token is.
type Redeemer interface {
	RedeemSpeechCapability(ctx context.Context, token string, purpose workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error)
}

// Voices speaks.
type Voices interface {
	Voices() []tts.Voice
	Synthesize(ctx context.Context, voiceID, text string) ([]byte, error)
}

// Recogniser recognises one clip.
type Recogniser interface {
	Transcribe(ctx context.Context, clip whisper.Request, urgent bool) ([]whisper.Utterance, error)
}

// Options bound what one person may ask for.
type Options struct {
	FFmpeg string
	// MaxClipBytes and MaxClipSeconds bound one dictated clip.
	MaxClipBytes   int64
	MaxClipSeconds int
	// SynthesizePerMinute and DictatePerMinute bound one person's requests.
	SynthesizePerMinute int
	DictatePerMinute    int
	// DictateConcurrency bounds how many clips are being decoded and recognised at once, across
	// everybody. Each one is an ffmpeg process beside a model that already fills the container.
	DictateConcurrency int
}

func (options Options) withDefaults() Options {
	if options.MaxClipBytes <= 0 {
		options.MaxClipBytes = 3 << 20
	}
	if options.MaxClipSeconds <= 0 {
		options.MaxClipSeconds = 90
	}
	if options.SynthesizePerMinute <= 0 {
		options.SynthesizePerMinute = 90
	}
	if options.DictatePerMinute <= 0 {
		options.DictatePerMinute = 30
	}
	if options.DictateConcurrency <= 0 {
		options.DictateConcurrency = 3
	}
	return options
}

const (
	maxTokenBytes       = 4096
	minTokenBytes       = 32
	maxSynthesizeBody   = 16 << 10
	maxHintRunes        = 400
	maxRememberedGrants = 2048
	// Unknown capabilities must not turn the public listener into unbounded concurrent Core
	// calls. Cached grants bypass this gate; a saturated gate refuses immediately.
	maxRedemptions = 8
	// refusalMemory is how long a token Core refused is refused here without asking again.
	refusalMemory = 30 * time.Second
	// HintHeader carries the dictation hint, percent-encoded. A header and not the query: the
	// hint is made of workspace titles, and addresses are what access logs keep.
	HintHeader = "X-Nix-Speech-Hint"
)

type Handler struct {
	redeemer   Redeemer
	voices     Voices
	recogniser Recogniser
	options    Options
	logger     *slog.Logger
	now        func() time.Time

	mu          sync.Mutex
	grants      map[[sha256.Size]byte]workerapi.SpeechGrant
	refusals    map[[sha256.Size]byte]time.Time
	counts      map[string]window
	dictates    chan struct{}
	redemptions chan struct{}
}

type window struct {
	started time.Time
	count   int
}

// New returns the handler for everything under /speech/v1/. Voices or the recogniser may be nil
// when this deployment does not have them; those routes then answer that they are unavailable.
func New(redeemer Redeemer, voices Voices, recogniser Recogniser, options Options, logger *slog.Logger) http.Handler {
	handler := &Handler{
		redeemer: redeemer, voices: voices, recogniser: recogniser, options: options.withDefaults(), logger: logger,
		now:      time.Now,
		grants:   map[[sha256.Size]byte]workerapi.SpeechGrant{},
		refusals: map[[sha256.Size]byte]time.Time{},
		counts:   map[string]window{},
	}
	handler.dictates = make(chan struct{}, handler.options.DictateConcurrency)
	handler.redemptions = make(chan struct{}, maxRedemptions)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /speech/v1/voices", handler.listVoices)
	mux.HandleFunc("POST /speech/v1/synthesize", handler.synthesize)
	mux.HandleFunc("POST /speech/v1/dictate", handler.dictate)
	return mux
}

func problem(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"code": code})
}

// authorize resolves the request's capability and counts the request against its owner. It has
// answered the request itself whenever it returns false.
func (handler *Handler) authorize(writer http.ResponseWriter, request *http.Request, purpose workerapi.SpeechPurpose, perMinute int) bool {
	token, found := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	// Anything that is not the shape of a capability is refused here, without a word to Core:
	// this route faces the internet, and every question it asks Core is one somebody can cause.
	if !found || len(token) < minTokenBytes || len(token) > maxTokenBytes || !tokenShaped(token) {
		problem(writer, http.StatusUnauthorized, "speech.capability_required")
		return false
	}
	// Keyed by purpose as well as token, so a capability for one use is never remembered as
	// good for the other.
	key := sha256.Sum256([]byte(string(purpose) + "\x00" + token))
	now := handler.now()
	handler.mu.Lock()
	grant, known := handler.grants[key]
	handler.mu.Unlock()
	if !known || !now.Before(grant.ExpiresAt) {
		if handler.recentlyRefused(key, now) {
			problem(writer, http.StatusForbidden, "speech.capability_refused")
			return false
		}
		select {
		case handler.redemptions <- struct{}{}:
		default:
			writer.Header().Set("Retry-After", "2")
			problem(writer, http.StatusServiceUnavailable, "speech.busy")
			return false
		}
		redeemed, err := handler.redeemer.RedeemSpeechCapability(request.Context(), token, purpose)
		<-handler.redemptions
		// The Core round trip may consume the grant's remaining lifetime.
		now = handler.now()
		if errors.Is(err, workerapi.ErrSpeechCapabilityRefused) {
			handler.rememberRefusal(key, now)
			problem(writer, http.StatusForbidden, "speech.capability_refused")
			return false
		}
		if err != nil {
			handler.logger.Warn("a speech capability could not be checked", "error", err)
			problem(writer, http.StatusServiceUnavailable, "speech.unavailable")
			return false
		}
		if !now.Before(redeemed.ExpiresAt) {
			problem(writer, http.StatusForbidden, "speech.capability_refused")
			return false
		}
		grant = *redeemed
		handler.remember(key, grant, now)
	}
	if !handler.allow(string(purpose)+":"+grant.TenantID+":"+grant.PrincipalID, perMinute, now) {
		writer.Header().Set("Retry-After", "60")
		problem(writer, http.StatusTooManyRequests, "speech.rate_limited")
		return false
	}
	return true
}

// tokenShaped reports whether a token is made only of what a capability is made of.
func tokenShaped(token string) bool {
	for _, character := range token {
		if !(character == '-' || character == '_' || character == '.' || character == '=' ||
			character >= '0' && character <= '9' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z') {
			return false
		}
	}
	return true
}

// recentlyRefused reports whether Core refused this token for this purpose a moment ago, so a
// client repeating a bad token costs Core one question and not one per request.
func (handler *Handler) recentlyRefused(key [sha256.Size]byte, now time.Time) bool {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	refused, known := handler.refusals[key]
	return known && now.Sub(refused) < refusalMemory
}

func (handler *Handler) rememberRefusal(key [sha256.Size]byte, now time.Time) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if len(handler.refusals) >= maxRememberedGrants {
		for known, refused := range handler.refusals {
			if now.Sub(refused) >= refusalMemory {
				delete(handler.refusals, known)
			}
		}
		if len(handler.refusals) >= maxRememberedGrants {
			clear(handler.refusals)
		}
	}
	handler.refusals[key] = now
}

func (handler *Handler) remember(key [sha256.Size]byte, grant workerapi.SpeechGrant, now time.Time) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if len(handler.grants) >= maxRememberedGrants {
		for known, existing := range handler.grants {
			if !now.Before(existing.ExpiresAt) {
				delete(handler.grants, known)
			}
		}
		// Still full of live grants: forget them all rather than grow. Each is one call to Core
		// away from being remembered again.
		if len(handler.grants) >= maxRememberedGrants {
			clear(handler.grants)
		}
	}
	handler.grants[key] = grant
}

func (handler *Handler) allow(owner string, perMinute int, now time.Time) bool {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if len(handler.counts) >= maxRememberedGrants {
		for known, existing := range handler.counts {
			if now.Sub(existing.started) >= time.Minute {
				delete(handler.counts, known)
			}
		}
	}
	current, known := handler.counts[owner]
	// Never evict a live owner's budget to admit a new one: that would reset their limit.
	// Refuse new owners until a window expires instead of growing without a ceiling.
	if !known && len(handler.counts) >= maxRememberedGrants {
		return false
	}
	if now.Sub(current.started) >= time.Minute {
		current = window{started: now}
	}
	if current.count >= perMinute {
		return false
	}
	current.count++
	handler.counts[owner] = current
	return true
}

func (handler *Handler) listVoices(writer http.ResponseWriter, request *http.Request) {
	if !handler.authorize(writer, request, workerapi.SpeechSynthesize, handler.options.SynthesizePerMinute) {
		return
	}
	voices := []tts.Voice{}
	if handler.voices != nil {
		voices = handler.voices.Voices()
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	// Transcription is answered here too: the same recogniser serves it, and a browser that can
	// reach this route at all is talking to a deployment that has the speech role.
	_ = json.NewEncoder(writer).Encode(struct {
		Voices        []tts.Voice `json:"voices"`
		Dictation     bool        `json:"dictation"`
		Transcription bool        `json:"transcription"`
	}{voices, handler.recogniser != nil, handler.recogniser != nil})
}

func (handler *Handler) synthesize(writer http.ResponseWriter, request *http.Request) {
	if !handler.authorize(writer, request, workerapi.SpeechSynthesize, handler.options.SynthesizePerMinute) {
		return
	}
	if handler.voices == nil {
		problem(writer, http.StatusServiceUnavailable, "speech.unavailable")
		return
	}
	var body struct {
		Voice string `json:"voice"`
		Text  string `json:"text"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxSynthesizeBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		problem(writer, http.StatusBadRequest, "speech.invalid")
		return
	}
	audio, err := handler.voices.Synthesize(request.Context(), body.Voice, body.Text)
	switch {
	case errors.Is(err, tts.ErrUnknownVoice):
		problem(writer, http.StatusNotFound, "speech.voice_unavailable")
	case errors.Is(err, tts.ErrInvalidText):
		problem(writer, http.StatusBadRequest, "speech.invalid")
	case errors.Is(err, tts.ErrBusy):
		writer.Header().Set("Retry-After", "2")
		problem(writer, http.StatusServiceUnavailable, "speech.busy")
	case err != nil:
		if request.Context().Err() == nil {
			handler.logger.Warn("speech synthesis failed", "voice", body.Voice, "error", err)
		}
		problem(writer, http.StatusServiceUnavailable, "speech.unavailable")
	default:
		writer.Header().Set("Content-Type", "audio/mpeg")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write(audio)
	}
}

func (handler *Handler) dictate(writer http.ResponseWriter, request *http.Request) {
	if !handler.authorize(writer, request, workerapi.SpeechDictate, handler.options.DictatePerMinute) {
		return
	}
	if handler.recogniser == nil {
		problem(writer, http.StatusServiceUnavailable, "speech.unavailable")
		return
	}
	hint, err := url.QueryUnescape(request.Header.Get(HintHeader))
	hint = strings.TrimSpace(hint)
	if err != nil || len([]rune(hint)) > maxHintRunes {
		problem(writer, http.StatusBadRequest, "speech.invalid")
		return
	}
	select {
	case handler.dictates <- struct{}{}:
		defer func() { <-handler.dictates }()
	default:
		writer.Header().Set("Retry-After", "2")
		problem(writer, http.StatusServiceUnavailable, "speech.busy")
		return
	}
	samples, status, code := handler.readClip(writer, request)
	if code != "" {
		problem(writer, status, code)
		return
	}
	text := ""
	if speechaudio.Level(samples) >= speechaudio.QuietLevel {
		utterances, err := handler.recogniser.Transcribe(request.Context(), whisper.Request{WAV: speechaudio.WAV(samples), Prompt: hint}, true)
		if errors.Is(err, whisper.ErrNotReady) {
			// The model is still loading or the recogniser is restarting: expected, brief, and
			// not worth a warning for every clip that arrives meanwhile.
			writer.Header().Set("Retry-After", "10")
			problem(writer, http.StatusServiceUnavailable, "speech.warming_up")
			return
		}
		if err != nil {
			if request.Context().Err() == nil {
				handler.logger.Warn("dictation failed", "error", err)
			}
			problem(writer, http.StatusServiceUnavailable, "speech.unavailable")
			return
		}
		parts := make([]string, 0, len(utterances))
		for _, utterance := range utterances {
			parts = append(parts, utterance.Text)
		}
		text = strings.Join(parts, " ")
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(struct {
		Text string `json:"text"`
	}{text})
}

// readClip spools the uploaded clip, decodes it and returns it as one channel. The spool file is
// gone before this returns.
func (handler *Handler) readClip(writer http.ResponseWriter, request *http.Request) ([]int16, int, string) {
	spool, err := worktemp.Create("nix-speech-*")
	if err != nil {
		return nil, http.StatusServiceUnavailable, "speech.unavailable"
	}
	path := spool.Name()
	defer func() { _ = os.Remove(path) }()
	written, copyErr := io.Copy(spool, http.MaxBytesReader(writer, request.Body, handler.options.MaxClipBytes))
	closeErr := spool.Close()
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(copyErr, &tooLarge):
		return nil, http.StatusRequestEntityTooLarge, "speech.clip_too_large"
	case copyErr != nil || closeErr != nil:
		return nil, http.StatusBadRequest, "speech.invalid"
	case written == 0:
		return nil, http.StatusBadRequest, "speech.invalid"
	}

	seconds := handler.options.MaxClipSeconds
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	// One channel: a dictated clip is one voice, and mixing it down in the decoder saves reading
	// and then halving a stereo copy here.
	command, err := speechcmd.Decode(ctx, handler.options.FFmpeg, path, speechaudio.SampleRate, 1, speechcmd.Limits{CPUSeconds: 30, MemoryBytes: 512 << 20})
	if err != nil {
		return nil, http.StatusServiceUnavailable, "speech.unavailable"
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, http.StatusServiceUnavailable, "speech.unavailable"
	}
	if err := command.Start(); err != nil {
		return nil, http.StatusServiceUnavailable, "speech.unavailable"
	}
	// One frame past the limit is read so that an over-long clip is told apart from one that
	// ends exactly on it.
	limit := int64(seconds)*speechaudio.SampleRate*2 + 2
	raw, readErr := io.ReadAll(io.LimitReader(stdout, limit))
	if int64(len(raw)) >= limit {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, http.StatusRequestEntityTooLarge, "speech.clip_too_long"
	}
	if waitErr := command.Wait(); waitErr != nil || readErr != nil || len(raw) < 2 {
		// The decoder being stopped by its deadline is this worker being slow, not the clip being bad.
		if ctx.Err() != nil && request.Context().Err() == nil {
			return nil, http.StatusServiceUnavailable, "speech.busy"
		}
		return nil, http.StatusBadRequest, "speech.clip_unreadable"
	}
	samples := make([]int16, len(raw)/2)
	for index := range samples {
		samples[index] = int16(binary.LittleEndian.Uint16(raw[index*2:]))
	}
	return samples, 0, ""
}
