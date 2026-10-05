package transcribe

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/tts"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
)

// These run the real binaries and are skipped unless a machine that has them says where they
// are. They are the proof that the command lines and the server's wire format are right, which
// the fakes in the other tests cannot give.
//
//	NIX_SPEECH_REAL_WHISPER_SERVER  path to whisper-server
//	NIX_SPEECH_REAL_WHISPER_MODEL   path to a ggml model
//	NIX_SPEECH_REAL_SAMPLE          path to a recording of English speech
//	NIX_SPEECH_REAL_EXPECT          a word the transcript must contain
//	NIX_SPEECH_REAL_PIPER           path to piper
//	NIX_SPEECH_REAL_VOICES_DIR      directory holding the default voices

func TestRealWhisperTranscribesARecording(t *testing.T) {
	binary, model, sample := os.Getenv("NIX_SPEECH_REAL_WHISPER_SERVER"), os.Getenv("NIX_SPEECH_REAL_WHISPER_MODEL"), os.Getenv("NIX_SPEECH_REAL_SAMPLE")
	if binary == "" || model == "" || sample == "" {
		t.Skip("real whisper binaries are not configured")
	}
	audio, err := os.ReadFile(sample)
	if err != nil {
		t.Fatal(err)
	}
	server, err := whisper.NewServer(whisper.Options{Binary: binary, Model: model, VADModel: os.Getenv("NIX_SPEECH_REAL_VAD_MODEL"), Threads: 3}, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	go server.Run(ctx)

	fixture := newFixture(t, audio, "none")
	fixture.handler.recogniser = server
	result, err := fixture.handler.Handle(ctx, job)

	if err != nil {
		t.Fatal(err)
	}
	var transcript strings.Builder
	for _, paragraph := range fixture.appender.paragraphs {
		transcript.WriteString(paragraph.Text + " ")
	}
	t.Logf("result = %+v, paragraphs = %d", result, len(fixture.appender.paragraphs))
	if expect := os.Getenv("NIX_SPEECH_REAL_EXPECT"); expect == "" || !strings.Contains(strings.ToLower(transcript.String()), strings.ToLower(expect)) {
		t.Fatalf("transcript %q does not contain %q", transcript.String(), expect)
	}
}

func TestRealPiperSpeaksEveryDefaultVoice(t *testing.T) {
	piper, directory := os.Getenv("NIX_SPEECH_REAL_PIPER"), os.Getenv("NIX_SPEECH_REAL_VOICES_DIR")
	if piper == "" || directory == "" {
		t.Skip("real piper is not configured")
	}
	synthesizer := tts.New(tts.Options{Piper: piper, FFmpeg: "ffmpeg", VoicesDir: directory, Voices: tts.DefaultVoices})
	if voices := synthesizer.Voices(); len(voices) != len(tts.DefaultVoices) {
		t.Fatalf("installed voices = %#v", voices)
	}
	for _, voice := range tts.DefaultVoices {
		audio, err := synthesizer.Synthesize(context.Background(), voice.ID, "Good morning. The release is at four.")
		if err != nil {
			t.Fatalf("%s: %v", voice.ID, err)
		}
		// An MP3 stream opens with an ID3 tag or a frame sync.
		if len(audio) < 2000 || !(string(audio[:3]) == "ID3" || audio[0] == 0xff && audio[1]&0xe0 == 0xe0) {
			t.Fatalf("%s produced %d bytes that are not MP3", voice.ID, len(audio))
		}
		t.Logf("%s: %d bytes", voice.ID, len(audio))
	}
}
