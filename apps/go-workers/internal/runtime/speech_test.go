package runtime

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/httpserver"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func speechSettings() config.Settings {
	return config.Settings{
		InternalAPIURL:          "http://api",
		InternalSecret:          "secret",
		RabbitMQURL:             "amqp://rabbit",
		CollaborationURL:        "http://collab",
		ObjectOrigins:           []string{"https://objects.example.test"},
		SpeechWhisperServer:     "whisper-server",
		SpeechWhisperModel:      "/models/ggml-small.en.bin",
		SpeechWhisperThreads:    3,
		SpeechFFmpeg:            "ffmpeg",
		SpeechFFprobe:           "ffprobe",
		SpeechPiper:             "piper",
		SpeechTranscribeTimeout: time.Hour,
		RequestTimeout:          time.Second,
	}
}

func TestSpeechRoleRequiresItsModelAndTheServicesAJobUses(t *testing.T) {
	roles := role.Set{role.Speech: true}
	if err := validateSettings(roles, speechSettings()); err != nil {
		t.Fatalf("speech role rejected valid configuration: %v", err)
	}
	for name, change := range map[string]func(*config.Settings){
		"a missing model":         func(settings *config.Settings) { settings.SpeechWhisperModel = "" },
		"no collaboration origin": func(settings *config.Settings) { settings.CollaborationURL = "" },
		"no object origins":       func(settings *config.Settings) { settings.ObjectOrigins = nil },
		"zero threads":            func(settings *config.Settings) { settings.SpeechWhisperThreads = 0 },
		"a timeout under a minute": func(settings *config.Settings) {
			settings.SpeechTranscribeTimeout = 30 * time.Second
		},
	} {
		settings := speechSettings()
		change(&settings)
		if err := validateSettings(roles, settings); err == nil {
			t.Fatalf("speech role accepted %s", name)
		}
	}
}

func TestSpeechReadinessNeedsItsConsumerCollaborationAndObjectStorage(t *testing.T) {
	state := newReadinessState(
		role.Set{role.Speech: true},
		func(queue string) bool { return queue == broker.TranscribeQueue },
		func() bool { return true },
	)
	state.api.Store(true)
	state.rabbit.Store(true)
	if state.RoleReady(role.Speech) {
		t.Fatal("speech role was ready without collaboration or object storage")
	}
	state.collaboration.Store(true)
	state.objects.Store(true)
	if !state.RoleReady(role.Speech) || !state.AllReady() {
		t.Fatal("speech role was not ready with healthy dependencies and an active consumer")
	}
	if queueForRole(role.Speech) != "nix.worker.transcribe.v1" {
		t.Fatalf("speech queue = %q", queueForRole(role.Speech))
	}
}

func TestSpeechRoutesAreMountedWithoutTheInternalSecretAndNothingElseIs(t *testing.T) {
	settings := speechSettings()
	speech, err := newSpeechRole(settings, workerapi.New("http://127.0.0.1:1", "secret", "worker", time.Second), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	if speech.voices != 0 {
		t.Fatalf("voices without a voices directory = %d", speech.voices)
	}
	server := httptest.NewServer(httpserver.NewForRole(role.Speech, httpserver.Dependencies{
		Logger: slog.New(slog.DiscardHandler), InternalSecret: "secret", RequestTimeout: time.Second,
		Ready: func() bool { return true }, Speech: speech.handler,
	}))
	defer server.Close()
	status := func(method, path string) int {
		request, _ := http.NewRequest(method, server.URL+path, nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return response.StatusCode
	}

	// Reached without the internal secret, and refused for want of a capability, not for want
	// of the secret.
	if code := status(http.MethodGet, "/speech/v1/voices"); code != http.StatusUnauthorized {
		t.Fatalf("voices without a capability = %d", code)
	}
	// The import routes are not part of a speech-only worker at all.
	if code := status(http.MethodPost, "/v1/import/ndjson"); code != http.StatusNotFound {
		t.Fatalf("import route on a speech worker = %d", code)
	}

	without := httptest.NewServer(httpserver.NewForRole(role.Import, httpserver.Dependencies{
		Logger: slog.New(slog.DiscardHandler), InternalSecret: "secret", RequestTimeout: time.Second,
		Ready: func() bool { return true },
	}))
	defer without.Close()
	request, _ := http.NewRequest(http.MethodGet, without.URL+"/speech/v1/voices", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("speech route on an import worker = %d", response.StatusCode)
	}
}

func TestSpeechRoleRefusesAnInvalidVoiceList(t *testing.T) {
	settings := speechSettings()
	settings.SpeechVoices = "not-a-voice-entry"
	if _, err := newSpeechRole(settings, workerapi.New("http://api", "secret", "worker", time.Second), slog.New(slog.DiscardHandler)); err == nil {
		t.Fatal("an invalid voice list was accepted")
	}
}
