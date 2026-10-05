package runtime

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/brokerjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/speechhttp"
	"github.com/sianachi/Nix/apps/go-workers/internal/transcribe"
	"github.com/sianachi/Nix/apps/go-workers/internal/tts"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// speechRole is what the speech role is made of: the resident recogniser, and the handler a
// browser reaches for voices and dictation. Built before the HTTP server so the handler can be
// mounted, and started with the other roles.
type speechRole struct {
	whisper *whisper.Server
	handler http.Handler
	voices  int
}

func newSpeechRole(settings config.Settings, api *workerapi.Client, logger *slog.Logger) (*speechRole, error) {
	recogniser, err := whisper.NewServer(whisper.Options{
		Binary:   settings.SpeechWhisperServer,
		Model:    settings.SpeechWhisperModel,
		VADModel: settings.SpeechWhisperVADModel,
		Threads:  settings.SpeechWhisperThreads,
		GPU:      settings.SpeechWhisperGPU,
	}, logger)
	if err != nil {
		return nil, err
	}
	voices, err := tts.ParseVoices(settings.SpeechVoices)
	if err != nil {
		return nil, err
	}
	// No voices directory is a deployment that transcribes and takes dictation but does not
	// speak; the handler then says speech is unavailable rather than the role failing to start.
	var speaker speechhttp.Voices
	installed := 0
	if settings.SpeechVoicesDir != "" {
		synthesizer := tts.New(tts.Options{
			Piper:     settings.SpeechPiper,
			FFmpeg:    settings.SpeechFFmpeg,
			VoicesDir: settings.SpeechVoicesDir,
			Voices:    voices,
		})
		installed = len(synthesizer.Voices())
		speaker = synthesizer
	}
	handler := speechhttp.New(api, speaker, recogniser, speechhttp.Options{FFmpeg: settings.SpeechFFmpeg}, logger)
	return &speechRole{whisper: recogniser, handler: handler, voices: installed}, nil
}

// start runs the recogniser and the transcription consumer. One recording at a time, whatever
// the worker's general concurrency: there is one model, and a second job would only wait on it.
func (speech *speechRole) start(ctx context.Context, settings config.Settings, brokerClient *broker.Client, api *workerapi.Client, logger *slog.Logger) error {
	collaboration, err := transcribe.NewCollaborationClient(settings.CollaborationURL, settings.InternalSecret, settings.RequestTimeout)
	if err != nil {
		return err
	}
	handler, err := transcribe.New(
		api,
		objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...),
		speech.whisper,
		collaboration,
		transcribe.Options{
			FFmpeg:        settings.SpeechFFmpeg,
			FFprobe:       settings.SpeechFFprobe,
			MaxBytes:      settings.MaxInputBytes,
			DecodeTimeout: settings.SpeechTranscribeTimeout,
		})
	if err != nil {
		return err
	}
	runner, err := brokerjob.New(brokerClient, api, handler, broker.TranscribeQueue, transcribe.Kinds, settings.WorkerID, 1, settings.LeaseDuration, settings.RenewInterval, logger)
	if err != nil {
		return err
	}
	logger.Info("speech role starting", "voices", speech.voices, "gpu", settings.SpeechWhisperGPU)
	go speech.whisper.Run(ctx)
	go runner.Run(ctx)
	return nil
}
