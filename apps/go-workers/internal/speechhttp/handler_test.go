package speechhttp

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/tts"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// Capabilities are long opaque strings; the handler refuses anything shorter without asking Core.
const (
	synthesizeToken  = "synthesize-0123456789abcdefghijklmnopqrstuvwxyz"
	synthesizeSecond = "synthesize-second-0123456789abcdefghijklmnopqrs"
	synthesizeOther  = "synthesize-other-0123456789abcdefghijklmnopqrst"
	dictateToken     = "dictate-0123456789abcdefghijklmnopqrstuvwxyz012"
)

type fakeRedeemer struct {
	calls []string
	err   error
	grant workerapi.SpeechGrant
}

func (redeemer *fakeRedeemer) RedeemSpeechCapability(_ context.Context, token string, purpose workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error) {
	redeemer.calls = append(redeemer.calls, string(purpose)+":"+token)
	if redeemer.err != nil {
		return nil, redeemer.err
	}
	// A capability is good for the purpose named in it and nothing else.
	if !strings.HasPrefix(token, string(purpose)) {
		return nil, workerapi.ErrSpeechCapabilityRefused
	}
	grant := redeemer.grant
	return &grant, nil
}

type fakeVoices struct {
	voice, text string
	err         error
}

func (voices *fakeVoices) Voices() []tts.Voice { return tts.DefaultVoices[:2] }

func (voices *fakeVoices) Synthesize(_ context.Context, voiceID, text string) ([]byte, error) {
	voices.voice, voices.text = voiceID, text
	if voices.err != nil {
		return nil, voices.err
	}
	return []byte("ID3audio"), nil
}

type fakeRecogniser struct {
	calls  int
	urgent bool
	prompt string
	err    error
}

func (recogniser *fakeRecogniser) Transcribe(_ context.Context, clip whisper.Request, urgent bool) ([]whisper.Utterance, error) {
	recogniser.calls++
	recogniser.urgent, recogniser.prompt = urgent, clip.Prompt
	if recogniser.err != nil {
		return nil, recogniser.err
	}
	return []whisper.Utterance{{Text: "Remind me"}, {Text: "to call Ada."}}, nil
}

type fixture struct {
	handler    http.Handler
	redeemer   *fakeRedeemer
	voices     *fakeVoices
	recogniser *fakeRecogniser
}

func newFixture(options Options) *fixture {
	result := &fixture{
		redeemer:   &fakeRedeemer{grant: workerapi.SpeechGrant{TenantID: "tenant", PrincipalID: "ada", ExpiresAt: time.Now().Add(5 * time.Minute)}},
		voices:     &fakeVoices{},
		recogniser: &fakeRecogniser{},
	}
	options.FFmpeg = "ffmpeg"
	result.handler = New(result.redeemer, result.voices, result.recogniser, options, slog.New(slog.DiscardHandler))
	return result
}

func (fixture *fixture) do(method, path, token string, body io.Reader) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, body)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	fixture.handler.ServeHTTP(recorder, request)
	return recorder
}

func code(recorder *httptest.ResponseRecorder) string {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return body.Code
}

func TestEveryRouteNeedsACapabilityForItsOwnPurpose(t *testing.T) {
	fixture := newFixture(Options{})

	if response := fixture.do("GET", "/speech/v1/voices", "", nil); response.Code != 401 || code(response) != "speech.capability_required" {
		t.Fatalf("no capability: %d %s", response.Code, response.Body)
	}
	if response := fixture.do("POST", "/speech/v1/dictate", synthesizeToken, strings.NewReader("x")); response.Code != 403 || code(response) != "speech.capability_refused" {
		t.Fatalf("wrong purpose: %d %s", response.Code, response.Body)
	}
	if fixture.recogniser.calls != 0 {
		t.Fatal("a refused request reached the recogniser")
	}
	asked := len(fixture.redeemer.calls)
	for name, token := range map[string]string{
		"oversized": strings.Repeat("a", maxTokenBytes+1),
		"short":     "short",
		"misshapen": strings.Repeat("a", 40) + " <script>",
	} {
		if response := fixture.do("GET", "/speech/v1/voices", token, nil); response.Code != 401 {
			t.Fatalf("%s token: %d", name, response.Code)
		}
	}
	// None of those was worth a question to Core, and a refused token is not asked about twice.
	if len(fixture.redeemer.calls) != asked {
		t.Fatalf("Core was asked about %d malformed tokens", len(fixture.redeemer.calls)-asked)
	}
	for range 5 {
		fixture.do("POST", "/speech/v1/dictate", synthesizeToken, strings.NewReader("x"))
	}
	if len(fixture.redeemer.calls) != asked {
		t.Fatalf("Core was asked %d more times about a token it had just refused", len(fixture.redeemer.calls)-asked)
	}
	fixture.redeemer.err = errors.New("core is down")
	if response := fixture.do("GET", "/speech/v1/voices", synthesizeOther, nil); response.Code != 503 || code(response) != "speech.unavailable" {
		t.Fatalf("core down: %d %s", response.Code, response.Body)
	}
}

func TestAGrantIsRememberedPerPurposeAndRequestsAreCounted(t *testing.T) {
	fixture := newFixture(Options{SynthesizePerMinute: 3})

	for range 3 {
		if response := fixture.do("GET", "/speech/v1/voices", synthesizeToken, nil); response.Code != 200 {
			t.Fatalf("voices: %d %s", response.Code, response.Body)
		}
	}
	if len(fixture.redeemer.calls) != 1 {
		t.Fatalf("Core was asked %d times for one capability", len(fixture.redeemer.calls))
	}
	limited := fixture.do("GET", "/speech/v1/voices", synthesizeToken, nil)
	if limited.Code != 429 || code(limited) != "speech.rate_limited" || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("limit: %d %s", limited.Code, limited.Body)
	}
	// Another capability of the same person is counted in the same window.
	if response := fixture.do("GET", "/speech/v1/voices", synthesizeSecond, nil); response.Code != 429 {
		t.Fatalf("second capability: %d", response.Code)
	}
}

func TestVoicesAreListedAndSpoken(t *testing.T) {
	fixture := newFixture(Options{})

	listed := fixture.do("GET", "/speech/v1/voices", synthesizeToken, nil)
	var body struct {
		Voices        []tts.Voice `json:"voices"`
		Dictation     bool        `json:"dictation"`
		Transcription bool        `json:"transcription"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &body); err != nil || len(body.Voices) != 2 || body.Voices[0].Name != "Ryan" || !body.Dictation || !body.Transcription {
		t.Fatalf("voices = %s", listed.Body)
	}

	spoken := fixture.do("POST", "/speech/v1/synthesize", synthesizeToken, strings.NewReader(`{"voice":"en_US-ryan-high","text":"Good morning."}`))
	if spoken.Code != 200 || spoken.Header().Get("Content-Type") != "audio/mpeg" || spoken.Header().Get("Cache-Control") != "no-store" || spoken.Body.String() != "ID3audio" {
		t.Fatalf("synthesize: %d %v", spoken.Code, spoken.Header())
	}
	if fixture.voices.voice != "en_US-ryan-high" || fixture.voices.text != "Good morning." {
		t.Fatalf("spoke %q with %q", fixture.voices.text, fixture.voices.voice)
	}

	for failure, want := range map[error]int{tts.ErrUnknownVoice: 404, tts.ErrInvalidText: 400, tts.ErrBusy: 503, errors.New("piper crashed"): 503} {
		fixture.voices.err = failure
		if response := fixture.do("POST", "/speech/v1/synthesize", synthesizeToken, strings.NewReader(`{"voice":"v","text":"t"}`)); response.Code != want {
			t.Fatalf("%v answered %d", failure, response.Code)
		}
	}
	if response := fixture.do("POST", "/speech/v1/synthesize", synthesizeToken, strings.NewReader(`{"voice":"v","text":"t","extra":1}`)); response.Code != 400 {
		t.Fatalf("unknown field: %d", response.Code)
	}
	if response := fixture.do("POST", "/speech/v1/synthesize", synthesizeToken, strings.NewReader(`{"text":"`+strings.Repeat("a", maxSynthesizeBody)+`"}`)); response.Code != 400 {
		t.Fatalf("oversized body: %d", response.Code)
	}
}

// clip is a mono 16 kHz WAV of a tone at the given level.
func clip(seconds float64, level float64) []byte {
	const rate = 16000
	frames := int(seconds * rate)
	data := make([]byte, 0, frames*2)
	for index := range frames {
		data = binary.LittleEndian.AppendUint16(data, uint16(int16(level*30000*math.Sin(2*math.Pi*440*float64(index)/rate))))
	}
	header := make([]byte, 44)
	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(36+len(data)))
	copy(header[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1)
	binary.LittleEndian.PutUint16(header[22:24], 1)
	binary.LittleEndian.PutUint32(header[24:28], rate)
	binary.LittleEndian.PutUint32(header[28:32], rate*2)
	binary.LittleEndian.PutUint16(header[32:34], 2)
	binary.LittleEndian.PutUint16(header[34:36], 16)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], uint32(len(data)))
	return append(header, data...)
}

func needsFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
}

func TestADictatedClipIsRecognisedAheadOfTheQueue(t *testing.T) {
	needsFFmpeg(t)
	fixture := newFixture(Options{})

	request := httptest.NewRequest("POST", "/speech/v1/dictate", bytes.NewReader(clip(1, 0.5)))
	request.Header.Set("Authorization", "Bearer "+dictateToken)
	request.Header.Set(HintHeader, "Ada%20Lovelace")
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	if response.Code != 200 || strings.TrimSpace(response.Body.String()) != `{"text":"Remind me to call Ada."}` {
		t.Fatalf("dictate: %d %s", response.Code, response.Body)
	}
	if !fixture.recogniser.urgent || fixture.recogniser.prompt != "Ada Lovelace" {
		t.Fatalf("urgent = %v, prompt = %q", fixture.recogniser.urgent, fixture.recogniser.prompt)
	}
}

func TestSilenceIsEmptyTextAndBadClipsAreRefused(t *testing.T) {
	needsFFmpeg(t)
	fixture := newFixture(Options{MaxClipSeconds: 1, MaxClipBytes: 96 << 10})

	silent := fixture.do("POST", "/speech/v1/dictate", dictateToken, bytes.NewReader(clip(0.5, 0)))
	if silent.Code != 200 || strings.TrimSpace(silent.Body.String()) != `{"text":""}` || fixture.recogniser.calls != 0 {
		t.Fatalf("silence: %d %s, calls = %d", silent.Code, silent.Body, fixture.recogniser.calls)
	}
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, strings.NewReader("not audio")); response.Code != 400 || code(response) != "speech.clip_unreadable" {
		t.Fatalf("unreadable: %d %s", response.Code, response.Body)
	}
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, bytes.NewReader(clip(2, 0.5))); response.Code != 413 || code(response) != "speech.clip_too_long" {
		t.Fatalf("too long: %d %s", response.Code, response.Body)
	}
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, bytes.NewReader(make([]byte, 128<<10))); response.Code != 413 || code(response) != "speech.clip_too_large" {
		t.Fatalf("too large: %d %s", response.Code, response.Body)
	}
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, strings.NewReader("")); response.Code != 400 {
		t.Fatalf("empty: %d", response.Code)
	}
	hinted := httptest.NewRequest("POST", "/speech/v1/dictate", bytes.NewReader(clip(0.5, 0.5)))
	hinted.Header.Set("Authorization", "Bearer "+dictateToken)
	hinted.Header.Set(HintHeader, strings.Repeat("a", maxHintRunes+1))
	long := httptest.NewRecorder()
	fixture.handler.ServeHTTP(long, hinted)
	if long.Code != 400 {
		t.Fatalf("long hint: %d", long.Code)
	}
	fixture.recogniser.err = whisper.ErrNotReady
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, bytes.NewReader(clip(0.5, 0.5))); response.Code != 503 || code(response) != "speech.warming_up" {
		t.Fatalf("recogniser loading: %d %s", response.Code, response.Body)
	}
	fixture.recogniser.err = errors.New("the recogniser crashed")
	if response := fixture.do("POST", "/speech/v1/dictate", dictateToken, bytes.NewReader(clip(0.5, 0.5))); response.Code != 503 || code(response) != "speech.unavailable" {
		t.Fatalf("recogniser down: %d %s", response.Code, response.Body)
	}
}

func TestMissingPartsAnswerUnavailable(t *testing.T) {
	redeemer := &fakeRedeemer{grant: workerapi.SpeechGrant{TenantID: "t", PrincipalID: "p", ExpiresAt: time.Now().Add(time.Minute)}}
	handler := New(redeemer, nil, nil, Options{}, slog.New(slog.DiscardHandler))
	serve := func(method, path, token string, body io.Reader) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, body)
		request.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	if response := serve("POST", "/speech/v1/synthesize", synthesizeToken, strings.NewReader(`{}`)); response.Code != 503 {
		t.Fatalf("synthesize: %d", response.Code)
	}
	if response := serve("POST", "/speech/v1/dictate", dictateToken, strings.NewReader("x")); response.Code != 503 {
		t.Fatalf("dictate: %d", response.Code)
	}
	listed := serve("GET", "/speech/v1/voices", synthesizeToken, nil)
	if strings.TrimSpace(listed.Body.String()) != `{"voices":[],"dictation":false,"transcription":false}` {
		t.Fatalf("voices = %s", listed.Body)
	}
	if response := serve("GET", "/speech/v1/other", synthesizeToken, nil); response.Code != 404 {
		t.Fatalf("unknown route: %d", response.Code)
	}
}

func TestAnExpiredGrantIsCheckedAgain(t *testing.T) {
	now := time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC)
	redeemer := &fakeRedeemer{grant: workerapi.SpeechGrant{TenantID: "t", PrincipalID: "p", ExpiresAt: now.Add(time.Minute)}}
	handler := &Handler{
		redeemer: redeemer, options: Options{}.withDefaults(), logger: slog.New(slog.DiscardHandler),
		redemptions: make(chan struct{}, maxRedemptions),
		now:         func() time.Time { return now },
		grants:      map[[32]byte]workerapi.SpeechGrant{}, refusals: map[[32]byte]time.Time{}, counts: map[string]window{},
	}
	ask := func() int {
		request := httptest.NewRequest("GET", "/speech/v1/voices", nil)
		request.Header.Set("Authorization", "Bearer "+synthesizeToken)
		recorder := httptest.NewRecorder()
		handler.listVoices(recorder, request)
		return recorder.Code
	}

	if ask() != 200 || ask() != 200 || len(redeemer.calls) != 1 {
		t.Fatalf("calls = %d", len(redeemer.calls))
	}
	now = now.Add(2 * time.Minute)
	// Core is asked again, and what it now says is itself already out of date.
	if status := ask(); status != 403 || len(redeemer.calls) != 2 {
		t.Fatalf("status = %d, calls = %d", status, len(redeemer.calls))
	}
}

// slowRecogniser holds every clip until it is released, so clips pile up.
type slowRecogniser struct {
	entered chan struct{}
	release chan struct{}
}

func (recogniser *slowRecogniser) Transcribe(context.Context, whisper.Request, bool) ([]whisper.Utterance, error) {
	recogniser.entered <- struct{}{}
	<-recogniser.release
	return nil, nil
}

func TestOnlyAFewClipsAreRecognisedAtOnce(t *testing.T) {
	needsFFmpeg(t)
	redeemer := &fakeRedeemer{grant: workerapi.SpeechGrant{TenantID: "t", PrincipalID: "p", ExpiresAt: time.Now().Add(time.Minute)}}
	recogniser := &slowRecogniser{entered: make(chan struct{}, 8), release: make(chan struct{})}
	handler := New(redeemer, nil, recogniser, Options{FFmpeg: "ffmpeg", DictateConcurrency: 2}, slog.New(slog.DiscardHandler))
	send := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/speech/v1/dictate", bytes.NewReader(clip(0.5, 0.5)))
		request.Header.Set("Authorization", "Bearer "+dictateToken)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	done := make(chan int, 2)
	for range 2 {
		go func() { done <- send().Code }()
	}
	<-recogniser.entered
	<-recogniser.entered

	third := send()

	if third.Code != 503 || code(third) != "speech.busy" || third.Header().Get("Retry-After") == "" {
		t.Fatalf("third clip: %d %s", third.Code, third.Body)
	}
	close(recogniser.release)
	if first, second := <-done, <-done; first != 200 || second != 200 {
		t.Fatalf("held clips answered %d and %d", first, second)
	}
}

func TestPrincipalRateWindowsStayBoundedWithoutResettingLiveBudgets(t *testing.T) {
	handler := &Handler{counts: map[string]window{}}
	now := time.Now()
	for index := range maxRememberedGrants {
		owner := strconv.Itoa(index)
		if !handler.allow(owner, 1, now) {
			t.Fatal("a window was refused before the bound")
		}
	}
	if handler.allow("new-owner", 1, now) || len(handler.counts) != maxRememberedGrants {
		t.Fatal("a new owner grew the full set of live windows")
	}
	if handler.allow("0", 1, now) {
		t.Fatal("admitting a new owner reset a live owner's budget")
	}
	if !handler.allow("new-owner", 1, now.Add(time.Minute)) {
		t.Fatal("expired windows did not release capacity")
	}
}

type blockedRedeemer struct {
	entered chan struct{}
	release chan struct{}
}

func (redeemer *blockedRedeemer) RedeemSpeechCapability(ctx context.Context, _ string, _ workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error) {
	redeemer.entered <- struct{}{}
	select {
	case <-redeemer.release:
		return &workerapi.SpeechGrant{TenantID: "tenant", PrincipalID: "ada", ExpiresAt: time.Now().Add(time.Minute)}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestPublicCapabilityRedemptionsHaveABoundedConcurrentGate(t *testing.T) {
	redeemer := &blockedRedeemer{entered: make(chan struct{}, maxRedemptions), release: make(chan struct{})}
	handler := New(redeemer, nil, nil, Options{}, slog.New(slog.DiscardHandler))
	var pending sync.WaitGroup
	for index := range maxRedemptions {
		pending.Add(1)
		go func() {
			defer pending.Done()
			request := httptest.NewRequest("GET", "/speech/v1/voices", nil)
			request.Header.Set("Authorization", "Bearer "+synthesizeToken+strconv.Itoa(index))
			handler.ServeHTTP(httptest.NewRecorder(), request)
		}()
	}
	defer func() { close(redeemer.release); pending.Wait() }()
	for range maxRedemptions {
		select {
		case <-redeemer.entered:
		case <-time.After(2 * time.Second):
			t.Fatal("redemptions did not reach Core")
		}
	}
	request := httptest.NewRequest("GET", "/speech/v1/voices", nil)
	request.Header.Set("Authorization", "Bearer "+synthesizeOther)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || code(response) != "speech.busy" {
		t.Fatalf("saturated gate = %d %s", response.Code, response.Body)
	}
}

type redeemFunc func(context.Context, string, workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error)

func (redeem redeemFunc) RedeemSpeechCapability(ctx context.Context, token string, purpose workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error) {
	return redeem(ctx, token, purpose)
}

func TestRedemptionCannotUseAGrantThatExpiredDuringTheCoreCall(t *testing.T) {
	now := time.Now()
	expires := now.Add(time.Second)
	handler := &Handler{
		now:     func() time.Time { return now },
		options: Options{}.withDefaults(), logger: slog.New(slog.DiscardHandler),
		grants: map[[32]byte]workerapi.SpeechGrant{}, refusals: map[[32]byte]time.Time{}, counts: map[string]window{},
		redemptions: make(chan struct{}, maxRedemptions),
		redeemer: redeemFunc(func(context.Context, string, workerapi.SpeechPurpose) (*workerapi.SpeechGrant, error) {
			now = now.Add(2 * time.Second)
			return &workerapi.SpeechGrant{TenantID: "tenant", PrincipalID: "ada", ExpiresAt: expires}, nil
		}),
	}
	request := httptest.NewRequest("GET", "/speech/v1/voices", nil)
	request.Header.Set("Authorization", "Bearer "+synthesizeToken)
	response := httptest.NewRecorder()
	handler.listVoices(response, request)
	if response.Code != http.StatusForbidden || len(handler.grants) != 0 {
		t.Fatalf("expired redemption = %d, remembered %d grants", response.Code, len(handler.grants))
	}
}
