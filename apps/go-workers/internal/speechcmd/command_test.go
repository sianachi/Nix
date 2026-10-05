package speechcmd

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var limits = Limits{CPUSeconds: 30, MemoryBytes: 1 << 30}

func TestDecodeReadsOnlyTheNamedFileAsStereoPCM(t *testing.T) {
	command, err := Decode(context.Background(), "ffmpeg", "/spool/upload", 16000, 2, limits)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Join(command.Args, " ")
	for _, want := range []string{"ffmpeg", "-protocol_whitelist file,pipe", "-format_whitelist matroska,webm,", "-i file:/spool/upload", "-map 0:a:0", "-ac 2 -ar 16000", "-f s16le pipe:1", "-nostdin"} {
		if !strings.Contains(line, want) {
			t.Fatalf("%q missing from %q", want, line)
		}
	}
}

func TestCommandsRefuseMissingLimits(t *testing.T) {
	if _, err := Decode(context.Background(), "ffmpeg", "in", 16000, 2, Limits{}); err == nil {
		t.Fatal("decode ran without limits")
	}
	if _, err := Decode(context.Background(), "ffmpeg", "in", 0, 2, limits); err == nil {
		t.Fatal("decode ran without a rate")
	}
	if _, err := Decode(context.Background(), "ffmpeg", "in", 16000, 3, limits); err == nil {
		t.Fatal("decode ran with three channels")
	}
	if _, err := EncodeMP3(context.Background(), "ffmpeg", "in.wav", Limits{CPUSeconds: 1}); err == nil {
		t.Fatal("encode ran without limits")
	}
	if _, err := Speak(context.Background(), "piper", "voice.onnx", "out.wav", Limits{MemoryBytes: 1}); err == nil {
		t.Fatal("speech ran without limits")
	}
}

func TestSpeakAndEncodeNameTheirFiles(t *testing.T) {
	speak, _ := Speak(context.Background(), "piper", "/voices/ryan.onnx", "/spool/out.wav", limits)
	if line := strings.Join(speak.Args, " "); !strings.Contains(line, "piper --model /voices/ryan.onnx --output_file /spool/out.wav") {
		t.Fatalf("speak = %q", line)
	}
	encode, _ := EncodeMP3(context.Background(), "ffmpeg", "/spool/out.wav", limits)
	if line := strings.Join(encode.Args, " "); !strings.Contains(line, "-i file:/spool/out.wav") || !strings.Contains(line, "-f mp3 pipe:1") {
		t.Fatalf("encode = %q", line)
	}
}

func TestSubprocessesDoNotInheritTheWorkersSecrets(t *testing.T) {
	t.Setenv("NIX_WORKER_INTERNAL_SECRET", "the-internal-secret")
	t.Setenv("NIX_RABBITMQ_URL", "amqp://nix-speech:password@rabbitmq/")
	t.Setenv("NVIDIA_VISIBLE_DEVICES", "all")
	t.Setenv("TMPDIR", "/var/lib/nix-worker/spool")

	for name, build := range map[string]func() (*exec.Cmd, error){
		"decode": func() (*exec.Cmd, error) { return Decode(context.Background(), "ffmpeg", "in", 16000, 1, limits) },
		"probe":  func() (*exec.Cmd, error) { return Duration(context.Background(), "ffprobe", "in", limits) },
		"encode": func() (*exec.Cmd, error) { return EncodeMP3(context.Background(), "ffmpeg", "in.wav", limits) },
		"speak":  func() (*exec.Cmd, error) { return Speak(context.Background(), "piper", "v.onnx", "o.wav", limits) },
	} {
		command, err := build()
		if err != nil {
			t.Fatal(err)
		}
		environment := strings.Join(command.Env, "\n")
		if strings.Contains(environment, "the-internal-secret") || strings.Contains(environment, "amqp://") {
			t.Fatalf("%s inherits a worker secret", name)
		}
		if !strings.Contains(environment, "TMPDIR=/var/lib/nix-worker/spool") || !strings.Contains(environment, "NVIDIA_VISIBLE_DEVICES=all") {
			t.Fatalf("%s lost what it needs to run: %q", name, environment)
		}
	}
}

// A playlist is the classic way to make a decoder open a file nobody uploaded. With the
// container allow-list it is not a format ffmpeg will consider at all.
func TestAPlaylistIsNotDecodedAsAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	directory := t.TempDir()
	playlist := filepath.Join(directory, "upload")
	if err := os.WriteFile(playlist, []byte("#EXTM3U\n#EXTINF:1,\n/etc/hosts\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command, err := Decode(context.Background(), "ffmpeg", playlist, 16000, 1, limits)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := command.Output(); err == nil || len(output) != 0 {
		t.Fatalf("a playlist decoded to %d bytes, err = %v", len(output), err)
	}
}
