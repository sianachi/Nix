package tts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installed(t *testing.T, ids ...string) string {
	t.Helper()
	directory := t.TempDir()
	for _, id := range ids {
		for _, suffix := range []string{".onnx", ".onnx.json"} {
			if err := os.WriteFile(filepath.Join(directory, id+suffix), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return directory
}

func TestOnlyInstalledVoicesAreOffered(t *testing.T) {
	directory := installed(t, "en_US-ryan-high", "en_GB-cori-high")
	// A model without its configuration cannot be spoken with.
	_ = os.WriteFile(filepath.Join(directory, "en_GB-alan-medium.onnx"), []byte("x"), 0o600)

	voices := New(Options{VoicesDir: directory, Voices: DefaultVoices}).Voices()

	if len(voices) != 2 || voices[0].Name != "Ryan" || voices[1].Name != "Cori" {
		t.Fatalf("voices = %#v", voices)
	}
}

func TestTheDefaultSetIsTwoMaleAndTwoFemale(t *testing.T) {
	counts := map[string]int{}
	for _, voice := range DefaultVoices {
		counts[voice.Gender]++
	}
	if counts["male"] != 2 || counts["female"] != 2 {
		t.Fatalf("counts = %v", counts)
	}
	voices, err := ParseVoices("")
	if err != nil || len(voices) != 4 {
		t.Fatalf("default voices = %v, %v", voices, err)
	}
}

func TestVoicesCanBeNamedInConfiguration(t *testing.T) {
	voices, err := ParseVoices("en_US-joe-medium|Joe|male|American, en_GB-jenny_dioco-medium|Jenny|female|British")
	if err != nil || len(voices) != 2 || voices[1] != (Voice{ID: "en_GB-jenny_dioco-medium", Name: "Jenny", Gender: "female", Accent: "British"}) {
		t.Fatalf("voices = %#v, %v", voices, err)
	}
	for _, invalid := range []string{"only|three|parts", "../etc/passwd|X|male|British", "a|A|male|x,a|B|male|x", "|A|male|x"} {
		if _, err := ParseVoices(invalid); err == nil {
			t.Fatalf("%q was accepted", invalid)
		}
	}
}

func TestTextIsFlattenedAndBounded(t *testing.T) {
	cleaned, err := Clean("  Hello,\n\tworld.\x00\r\n  Again. ")
	if err != nil || cleaned != "Hello, world. Again." {
		t.Fatalf("cleaned = %q, %v", cleaned, err)
	}
	if _, err := Clean(" \n\t "); !errors.Is(err, ErrInvalidText) {
		t.Fatalf("err = %v", err)
	}
	if _, err := Clean(strings.Repeat("a", MaxTextRunes+1)); !errors.Is(err, ErrInvalidText) {
		t.Fatalf("err = %v", err)
	}
	if _, err := Clean(strings.Repeat("é", MaxTextRunes)); err != nil {
		t.Fatalf("a passage at the limit was refused: %v", err)
	}
}

func TestRefusalsHappenBeforeAnythingRuns(t *testing.T) {
	synthesizer := New(Options{Piper: "/nonexistent/piper", FFmpeg: "/nonexistent/ffmpeg", VoicesDir: installed(t, "en_US-ryan-high"), Voices: DefaultVoices, Concurrency: 1})

	if _, err := synthesizer.Synthesize(context.Background(), "en_GB-alan-medium", "Hello."); !errors.Is(err, ErrUnknownVoice) {
		t.Fatalf("err = %v", err)
	}
	if _, err := synthesizer.Synthesize(context.Background(), "en_US-ryan-high", ""); !errors.Is(err, ErrInvalidText) {
		t.Fatalf("err = %v", err)
	}
	synthesizer.slots <- struct{}{}
	if _, err := synthesizer.Synthesize(context.Background(), "en_US-ryan-high", "Hello."); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
}
