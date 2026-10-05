package speechaudio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func pcm(left, right []int16) []byte {
	out := make([]byte, 0, len(left)*4)
	for index := range left {
		out = binary.LittleEndian.AppendUint16(out, uint16(left[index]))
		out = binary.LittleEndian.AppendUint16(out, uint16(right[index]))
	}
	return out
}

// loudWithPause is constant noise with silence over [from, to).
func loudWithPause(samples, from, to int) []int16 {
	out := make([]int16, samples)
	for index := range out {
		if index < from || index >= to {
			out[index] = 8000
			if index%2 == 0 {
				out[index] = -8000
			}
		}
	}
	return out
}

func TestSegmentsAreCutInThePauseAndCoverTheWholeRecording(t *testing.T) {
	limits := Limits{TargetSamples: 2 * SampleRate, MaxSamples: 3 * SampleRate}
	total := 7 * SampleRate
	pauseFrom, pauseTo := 5*SampleRate/2, 5*SampleRate/2+windowSamples
	left := loudWithPause(total, pauseFrom, pauseTo)
	segmenter, err := NewSegmenter(bytes.NewReader(pcm(left, left)), limits)
	if err != nil {
		t.Fatal(err)
	}

	var segments []Segment
	for {
		segment, err := segmenter.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		segments = append(segments, segment)
	}

	if len(segments) < 3 {
		t.Fatalf("segments = %d", len(segments))
	}
	if cut := len(segments[0].Left); cut < pauseFrom || cut > pauseTo {
		t.Fatalf("first cut at %d, want inside the pause %d..%d", cut, pauseFrom, pauseTo)
	}
	var covered int64
	for _, segment := range segments {
		if segment.StartSample != covered {
			t.Fatalf("segment starts at %d, want %d", segment.StartSample, covered)
		}
		if len(segment.Left) > limits.MaxSamples || len(segment.Left) != len(segment.Right) {
			t.Fatalf("segment of %d/%d samples", len(segment.Left), len(segment.Right))
		}
		covered += int64(len(segment.Left))
	}
	if covered != int64(total) {
		t.Fatalf("covered %d of %d samples", covered, total)
	}
	if segments[1].StartMillis() != int64(len(segments[0].Left))*1000/SampleRate {
		t.Fatalf("start millis = %d", segments[1].StartMillis())
	}
}

func TestATruncatedFrameIsDroppedAndAnEmptyStreamIsTheEnd(t *testing.T) {
	data := append(pcm([]int16{1, 2}, []int16{3, 4}), 0xff, 0xff, 0xff)
	segmenter, _ := NewSegmenter(bytes.NewReader(data), DefaultLimits)
	segment, err := segmenter.Next()
	if err != nil || len(segment.Left) != 2 || segment.Right[1] != 4 {
		t.Fatalf("segment = %#v, err = %v", segment, err)
	}
	if _, err := segmenter.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("err = %v", err)
	}
	empty, _ := NewSegmenter(bytes.NewReader(nil), DefaultLimits)
	if _, err := empty.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("err = %v", err)
	}
	if _, err := NewSegmenter(bytes.NewReader(nil), Limits{TargetSamples: 10, MaxSamples: 5}); err == nil {
		t.Fatal("invalid limits accepted")
	}
}

func TestChannelsAreToldApartFromACopy(t *testing.T) {
	voice := loudWithPause(SampleRate, 0, 0)
	other := make([]int16, SampleRate)
	for index := range other {
		other[index] = int16(index % 500)
	}
	if !(Segment{Left: voice, Right: voice}).SameSound() {
		t.Fatal("identical channels reported as different")
	}
	if (Segment{Left: voice, Right: other}).SameSound() {
		t.Fatal("different channels reported as the same")
	}
	if !(Segment{Left: make([]int16, 8), Right: make([]int16, 8)}).SameSound() {
		t.Fatal("silence reported as two sounds")
	}
	if level := Level(voice); level < 0.24 || level > 0.25 {
		t.Fatalf("level = %f", level)
	}
	if Level(nil) != 0 {
		t.Fatal("level of nothing is not zero")
	}
	if mixed := (Segment{Left: []int16{100, -100}, Right: []int16{300, 100}}).Mix(); mixed[0] != 200 || mixed[1] != 0 {
		t.Fatalf("mixed = %v", mixed)
	}
}

func TestWAVIsAMono16BitFileOfTheSamples(t *testing.T) {
	wav := WAV([]int16{1, -2, 3})
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || len(wav) != 44+6 {
		t.Fatalf("header = %q, length = %d", wav[:12], len(wav))
	}
	if binary.LittleEndian.Uint32(wav[24:28]) != SampleRate || binary.LittleEndian.Uint16(wav[22:24]) != 1 {
		t.Fatal("format is not mono at the recogniser's rate")
	}
	if int16(binary.LittleEndian.Uint16(wav[46:48])) != -2 {
		t.Fatal("samples were not written in order")
	}
}
