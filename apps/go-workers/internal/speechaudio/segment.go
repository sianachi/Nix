// Package speechaudio cuts decoded speech into pieces a recogniser can take one at a time.
//
// A meeting is an hour of audio and a recogniser answers in seconds only for short clips, so the
// decoded stream is read once, front to back, and handed on in segments of bounded length. Nothing
// larger than one segment is ever held: an hour of 16 kHz stereo is 230 MiB as a file and a little
// over 5 MiB here.
package speechaudio

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"math"
)

const (
	// SampleRate is what the recogniser expects and what the decoder is asked to produce.
	SampleRate = 16000
	// Channels is fixed at two: a recording made by Nix keeps the microphone on the left and the
	// shared audio on the right, and anything else decodes to two copies or an ordinary stereo pair.
	Channels = 2

	frameBytes = 2 * Channels
	// A cut is looked for in windows this long, and made in the quietest one.
	windowSamples = SampleRate / 10
)

// Limits bound a segment. A cut is made at the quietest tenth of a second between Target and
// Max, so a sentence is split in a pause wherever there is one.
type Limits struct {
	TargetSamples int
	MaxSamples    int
}

// DefaultLimits keeps every segment inside the recogniser's own thirty-second window. A segment a
// second over it costs a second full pass that is nearly all padding, so the maximum sits just
// under the window and the cut is looked for in the eight seconds before it.
var DefaultLimits = Limits{TargetSamples: 22 * SampleRate, MaxSamples: 59 * SampleRate / 2}

// QuietLevel is the level under which a channel is treated as carrying nothing, so a silent
// microphone or an idle shared tab is not sent to the recogniser at all.
const QuietLevel = 0.002

// Segment is one piece of the recording, both channels, with its place in the whole.
type Segment struct {
	// StartSample counts from the beginning of the recording.
	StartSample int64
	Left        []int16
	Right       []int16
}

// StartMillis is where the segment begins in the recording.
func (segment Segment) StartMillis() int64 { return segment.StartSample * 1000 / SampleRate }

// Millis is how long the segment is.
func (segment Segment) Millis() int64 { return int64(len(segment.Left)) * 1000 / SampleRate }

// Level is the root mean square of a channel on a scale where full volume is one.
func Level(samples []int16) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, sample := range samples {
		value := float64(sample) / 32768
		sum += value * value
	}
	return math.Sqrt(sum / float64(len(samples)))
}

// SameSound reports whether the two channels carry the same thing, which is what a mono source
// decoded to stereo looks like: the difference between them is a small part of either.
func (segment Segment) SameSound() bool {
	var difference, total float64
	for index := range segment.Left {
		left, right := float64(segment.Left[index]), float64(segment.Right[index])
		difference += (left - right) * (left - right)
		total += left*left + right*right
	}
	return total == 0 || difference <= total*0.01
}

// Segmenter reads interleaved signed 16-bit little-endian stereo at SampleRate.
type Segmenter struct {
	reader *bufio.Reader
	limits Limits
	left   []int16
	right  []int16
	start  int64
	done   bool
}

func NewSegmenter(reader io.Reader, limits Limits) (*Segmenter, error) {
	if limits.TargetSamples < windowSamples || limits.MaxSamples < limits.TargetSamples+windowSamples {
		return nil, errors.New("segment limits are invalid")
	}
	return &Segmenter{reader: bufio.NewReaderSize(reader, 64*1024), limits: limits}, nil
}

// Next returns the next segment, or io.EOF once the recording is exhausted. A trailing partial
// frame, which a truncated decode can leave, is dropped.
func (segmenter *Segmenter) Next() (Segment, error) {
	var frame [frameBytes]byte
	for !segmenter.done && len(segmenter.left) < segmenter.limits.MaxSamples {
		if _, err := io.ReadFull(segmenter.reader, frame[:]); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				segmenter.done = true
				break
			}
			return Segment{}, err
		}
		segmenter.left = append(segmenter.left, int16(binary.LittleEndian.Uint16(frame[0:2])))
		segmenter.right = append(segmenter.right, int16(binary.LittleEndian.Uint16(frame[2:4])))
	}
	if len(segmenter.left) == 0 {
		return Segment{}, io.EOF
	}
	cut := len(segmenter.left)
	if !segmenter.done {
		cut = segmenter.quietestCut()
	}
	segment := Segment{
		StartSample: segmenter.start,
		Left:        append([]int16(nil), segmenter.left[:cut]...),
		Right:       append([]int16(nil), segmenter.right[:cut]...),
	}
	segmenter.left = append(segmenter.left[:0], segmenter.left[cut:]...)
	segmenter.right = append(segmenter.right[:0], segmenter.right[cut:]...)
	segmenter.start += int64(cut)
	return segment, nil
}

// quietestCut picks the middle of the quietest window between the target and the maximum, judged
// on both channels together so the two are always cut at the same instant.
func (segmenter *Segmenter) quietestCut() int {
	best, bestEnergy := segmenter.limits.TargetSamples, math.Inf(1)
	for at := segmenter.limits.TargetSamples; at+windowSamples <= len(segmenter.left); at += windowSamples {
		var energy float64
		for index := at; index < at+windowSamples; index++ {
			left, right := float64(segmenter.left[index]), float64(segmenter.right[index])
			energy += left*left + right*right
		}
		if energy < bestEnergy {
			best, bestEnergy = at+windowSamples/2, energy
		}
	}
	return best
}

// WAV wraps one channel as a mono 16-bit file, the form the recogniser reads.
func WAV(samples []int16) []byte {
	data := len(samples) * 2
	out := make([]byte, 44+data)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+data))
	copy(out[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1)
	binary.LittleEndian.PutUint16(out[22:24], 1)
	binary.LittleEndian.PutUint32(out[24:28], SampleRate)
	binary.LittleEndian.PutUint32(out[28:32], SampleRate*2)
	binary.LittleEndian.PutUint16(out[32:34], 2)
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(data))
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(out[44+index*2:], uint16(sample))
	}
	return out
}

// Mix averages the two channels into one, for a recording that is not split by speaker.
func (segment Segment) Mix() []int16 {
	mixed := make([]int16, len(segment.Left))
	for index := range segment.Left {
		mixed[index] = int16((int32(segment.Left[index]) + int32(segment.Right[index])) / 2)
	}
	return mixed
}
