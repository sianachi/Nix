// Package speechcmd builds the external commands the speech role runs: ffmpeg to decode and
// encode, Piper to speak. Each is bounded in processor time and address space where the platform
// can enforce it, as PDF extraction is, because each is handed bytes or text somebody uploaded.
// Each also starts with a near-empty environment: these are native parsers reading untrusted
// input, and the worker's own environment holds the secret it speaks to Core with.
package speechcmd

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Limits bound one command.
type Limits struct {
	CPUSeconds  int
	MemoryBytes int64
}

func (limits Limits) valid() bool { return limits.CPUSeconds > 0 && limits.MemoryBytes > 0 }

// audioContainers is every container a recording arrives in. ffmpeg is told to consider these
// and nothing else, so a file that is really a playlist or a script for one of its other
// demuxers is refused instead of being followed to whatever it names.
const audioContainers = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3,ogg,wav,flac,aac"

// passedThrough are the only variables a child inherits: enough to find its libraries and its
// spool directory, and what the GPU runtime needs. Everything else stays with the worker.
var passedThrough = []string{"PATH", "TMPDIR", "HOME", "LANG", "LD_LIBRARY_PATH"}

// Environment is what a speech subprocess starts with.
func Environment() []string {
	var environment []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		keep := strings.HasPrefix(name, "NVIDIA_") || strings.HasPrefix(name, "CUDA_")
		for _, allowed := range passedThrough {
			keep = keep || name == allowed
		}
		if keep {
			environment = append(environment, entry)
		}
	}
	return environment
}

// Decode turns audio into interleaved signed 16-bit samples at rate on standard output, in one
// channel or two. Only the first audio stream is read, only from the named file and only from a
// known audio container: the input is pinned to the file protocol, so what is decoded is the
// upload and not something the upload points at.
func Decode(ctx context.Context, ffmpeg, sourcePath string, rate, channels int, limits Limits) (*exec.Cmd, error) {
	if !limits.valid() || rate <= 0 || channels < 1 || channels > 2 {
		return nil, errors.New("decode limits are invalid")
	}
	return bounded(ctx, limits, ffmpeg,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-protocol_whitelist", "file,pipe",
		"-format_whitelist", audioContainers,
		"-i", "file:"+sourcePath,
		"-map", "0:a:0", "-vn", "-sn", "-dn",
		"-ac", strconv.Itoa(channels), "-ar", strconv.Itoa(rate),
		"-f", "s16le", "pipe:1")
}

// EncodeMP3 turns a WAV file into a small mono MP3 on standard output, the one compressed audio
// format every browser plays.
func EncodeMP3(ctx context.Context, ffmpeg, wavPath string, limits Limits) (*exec.Cmd, error) {
	if !limits.valid() {
		return nil, errors.New("encode limits are invalid")
	}
	return bounded(ctx, limits, ffmpeg,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-protocol_whitelist", "file,pipe",
		"-f", "wav", "-i", "file:"+wavPath,
		"-ac", "1", "-b:a", "48k",
		"-f", "mp3", "pipe:1")
}

// Speak runs Piper with one voice, reading text on standard input and writing a WAV file.
func Speak(ctx context.Context, piper, modelPath, wavPath string, limits Limits) (*exec.Cmd, error) {
	if !limits.valid() {
		return nil, errors.New("speech limits are invalid")
	}
	return bounded(ctx, limits, piper, "--model", modelPath, "--output_file", wavPath)
}

// Duration asks ffprobe how long a file's audio is, in seconds, on standard output. The answer is
// only used to say how far a transcription has got, so a file that does not know is not an error.
func Duration(ctx context.Context, ffprobe, sourcePath string, limits Limits) (*exec.Cmd, error) {
	if !limits.valid() {
		return nil, errors.New("probe limits are invalid")
	}
	return bounded(ctx, limits, ffprobe,
		"-v", "error",
		"-protocol_whitelist", "file",
		"-format_whitelist", audioContainers,
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		"file:"+sourcePath)
}
