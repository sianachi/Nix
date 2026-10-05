// Package tts turns text into speech with a local Piper voice.
package tts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/sianachi/Nix/apps/go-workers/internal/speechcmd"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

// MaxTextRunes bounds one request. A client reading something long sends it a passage at a time,
// which is also what lets the first passage start playing while the rest is still being spoken.
const MaxTextRunes = 1200

// maxAudioBytes bounds what one request may produce: MaxTextRunes of speech is well under this.
const maxAudioBytes = 8 << 20

// Voice describes one voice a person can choose.
type Voice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Gender string `json:"gender"`
	Accent string `json:"accent"`
}

// DefaultVoices is the set this build is curated for: two male and two female, one American and
// one British of each. A deployment that wants others names them in configuration.
var DefaultVoices = []Voice{
	{ID: "en_US-ryan-high", Name: "Ryan", Gender: "male", Accent: "American"},
	{ID: "en_GB-alan-medium", Name: "Alan", Gender: "male", Accent: "British"},
	{ID: "en_US-lessac-high", Name: "Lessac", Gender: "female", Accent: "American"},
	{ID: "en_GB-cori-high", Name: "Cori", Gender: "female", Accent: "British"},
}

// ParseVoices reads "id|Name|gender|accent" entries separated by commas.
func ParseVoices(value string) ([]Voice, error) {
	if strings.TrimSpace(value) == "" {
		return DefaultVoices, nil
	}
	var voices []Voice
	seen := map[string]bool{}
	for entry := range strings.SplitSeq(value, ",") {
		parts := strings.Split(strings.TrimSpace(entry), "|")
		if len(parts) != 4 {
			return nil, fmt.Errorf("voice %q is not id|Name|gender|accent", entry)
		}
		voice := Voice{ID: strings.TrimSpace(parts[0]), Name: strings.TrimSpace(parts[1]), Gender: strings.TrimSpace(parts[2]), Accent: strings.TrimSpace(parts[3])}
		if !validID(voice.ID) || voice.Name == "" || seen[voice.ID] {
			return nil, fmt.Errorf("voice %q is invalid or repeated", entry)
		}
		seen[voice.ID] = true
		voices = append(voices, voice)
	}
	return voices, nil
}

// validID keeps a voice id to what is safe as a file name: it is joined to the voices directory.
func validID(id string) bool {
	if id == "" || len(id) > 80 {
		return false
	}
	for _, character := range id {
		if !(character == '-' || character == '_' || character >= '0' && character <= '9' ||
			character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z') {
			return false
		}
	}
	return true
}

var (
	// ErrUnknownVoice is a voice that is not offered or whose model is not installed.
	ErrUnknownVoice = errors.New("the voice is not available")
	// ErrInvalidText is empty or over-long text.
	ErrInvalidText = errors.New("the text is empty or too long")
	// ErrBusy means every synthesis slot is taken.
	ErrBusy = errors.New("speech is busy")
)

// Options name the binaries and where the voice models are.
type Options struct {
	Piper     string
	FFmpeg    string
	VoicesDir string
	Voices    []Voice
	// Concurrency bounds how many passages are spoken at once.
	Concurrency int
	Timeout     time.Duration
}

// Synthesizer speaks with the voices whose models are installed.
type Synthesizer struct {
	options Options
	models  map[string]string
	voices  []Voice
	slots   chan struct{}
}

// New keeps only the voices whose model and configuration files are present, so what is
// advertised is what can actually be spoken.
func New(options Options) *Synthesizer {
	if options.Concurrency <= 0 {
		options.Concurrency = 2
	}
	if options.Timeout <= 0 {
		options.Timeout = 60 * time.Second
	}
	synthesizer := &Synthesizer{options: options, models: map[string]string{}, slots: make(chan struct{}, options.Concurrency)}
	for _, voice := range options.Voices {
		model := filepath.Join(options.VoicesDir, voice.ID+".onnx")
		if regular(model) && regular(model+".json") {
			synthesizer.models[voice.ID] = model
			synthesizer.voices = append(synthesizer.voices, voice)
		}
	}
	return synthesizer
}

func regular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// Voices lists what can be spoken with, in the configured order.
func (synthesizer *Synthesizer) Voices() []Voice {
	return append([]Voice(nil), synthesizer.voices...)
}

// Clean prepares text for speaking: one line, no control characters, bounded.
func Clean(text string) (string, error) {
	var builder strings.Builder
	space := false
	for _, character := range text {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			space = builder.Len() > 0
			continue
		}
		if space {
			builder.WriteByte(' ')
			space = false
		}
		builder.WriteRune(character)
	}
	cleaned := builder.String()
	if cleaned == "" || len([]rune(cleaned)) > MaxTextRunes {
		return "", ErrInvalidText
	}
	return cleaned, nil
}

// Synthesize speaks text with a voice and returns MP3 bytes.
func (synthesizer *Synthesizer) Synthesize(ctx context.Context, voiceID, text string) ([]byte, error) {
	model, ok := synthesizer.models[voiceID]
	if !ok {
		return nil, ErrUnknownVoice
	}
	cleaned, err := Clean(text)
	if err != nil {
		return nil, err
	}
	select {
	case synthesizer.slots <- struct{}{}:
		defer func() { <-synthesizer.slots }()
	default:
		return nil, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, synthesizer.options.Timeout)
	defer cancel()

	wav, err := worktemp.Create("nix-speech-*")
	if err != nil {
		return nil, err
	}
	wavPath := wav.Name()
	_ = wav.Close()
	defer func() { _ = os.Remove(wavPath) }()

	limits := speechcmd.Limits{CPUSeconds: int(synthesizer.options.Timeout / time.Second), MemoryBytes: 4 << 30}
	speak, err := speechcmd.Speak(ctx, synthesizer.options.Piper, model, wavPath, limits)
	if err != nil {
		return nil, err
	}
	speak.Stdin = strings.NewReader(cleaned + "\n")
	speak.Stdout = io.Discard
	// Piper's own complaints are not kept: they can quote the text it was asked to speak, and
	// what a person has read aloud is never logged.
	speak.Stderr = io.Discard
	if err := speak.Run(); err != nil {
		return nil, fmt.Errorf("piper failed: %w", err)
	}

	encode, err := speechcmd.EncodeMP3(ctx, synthesizer.options.FFmpeg, wavPath, limits)
	if err != nil {
		return nil, err
	}
	var audio bytes.Buffer
	var encodeErr limited
	encode.Stdout = &capped{buffer: &audio, limit: maxAudioBytes}
	encode.Stderr = &encodeErr
	if err := encode.Run(); err != nil {
		return nil, fmt.Errorf("encoding failed: %w: %s", err, encodeErr.String())
	}
	if audio.Len() == 0 {
		return nil, errors.New("no audio was produced")
	}
	return audio.Bytes(), nil
}

// limited keeps the first few kilobytes of a command's complaints for the log.
type limited struct{ bytes.Buffer }

func (buffer *limited) Write(data []byte) (int, error) {
	if room := 4096 - buffer.Len(); room > 0 {
		buffer.Buffer.Write(data[:min(room, len(data))])
	}
	return len(data), nil
}

// capped fails a write that would take the output past its limit.
type capped struct {
	buffer *bytes.Buffer
	limit  int
}

func (writer *capped) Write(data []byte) (int, error) {
	if writer.buffer.Len()+len(data) > writer.limit {
		return 0, errors.New("the audio is larger than one passage can be")
	}
	return writer.buffer.Write(data)
}
