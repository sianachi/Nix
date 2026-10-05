// Package transcribe turns a recording into a transcript in the note it belongs to.
//
// The job is leased like any other. Core says where the audio is; the audio is decoded once, cut
// into short segments and recognised a segment at a time by the resident whisper server; and the
// finished paragraphs are handed to Collaboration, which appends them to the note. Nothing is
// written to the note until the whole recording has been recognised, so a job that dies half way
// leaves the note as it was and a retry starts clean. Only how far it has got is reported along
// the way.
package transcribe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/speechaudio"
	"github.com/sianachi/Nix/apps/go-workers/internal/speechcmd"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

// Kind is the job this package handles.
const Kind = "transcribe.audio"

// Kinds is the job kind the speech role's runner registers for the transcribe queue.
var Kinds = []string{Kind}

// Result is recorded on the finished job.
type Result struct {
	NoteItemID     string `json:"noteItemId"`
	AudioItemID    string `json:"audioItemId"`
	Paragraphs     int    `json:"paragraphs"`
	DurationMillis int64  `json:"durationMillis"`
}

// API is what the handler asks of Core.
type API interface {
	GetTranscriptionSource(ctx context.Context) (*workerapi.TranscriptionSource, error)
	ReportTranscriptionProgress(ctx context.Context, percent int) error
}

// Recogniser recognises one clip.
type Recogniser interface {
	Transcribe(ctx context.Context, clip whisper.Request, urgent bool) ([]whisper.Utterance, error)
}

// Appender hands the finished transcript to Collaboration.
type Appender interface {
	Append(ctx context.Context, durationMillis int64, paragraphs []Paragraph) error
}

// Options name the decoder and bound it.
type Options struct {
	FFmpeg   string
	FFprobe  string
	MaxBytes int64
	// DecodeTimeout bounds the whole decode-and-recognise pass over one recording.
	DecodeTimeout time.Duration
}

type Handler struct {
	api        API
	transfer   *objecttransfer.Client
	recogniser Recogniser
	appender   Appender
	options    Options
}

func New(api API, transfer *objecttransfer.Client, recogniser Recogniser, appender Appender, options Options) (*Handler, error) {
	if api == nil || transfer == nil || recogniser == nil || appender == nil || options.FFmpeg == "" || options.FFprobe == "" || options.MaxBytes <= 0 || options.DecodeTimeout <= 0 {
		return nil, errors.New("transcription handler configuration is invalid")
	}
	return &Handler{api: api, transfer: transfer, recogniser: recogniser, appender: appender, options: options}, nil
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	if job.Kind != Kind {
		return nil, invalid("transcribe.kind_mismatch", errors.New("job kind is not transcribe.audio"))
	}
	source, err := handler.api.GetTranscriptionSource(ctx)
	if err != nil {
		return nil, apiFailure("transcribe.source_unavailable", err)
	}
	path, err := handler.fetch(ctx, source)
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(path) }()

	spoken, durationMillis, err := handler.recognise(ctx, path, source.Speakers == "channels")
	if err != nil {
		return nil, err
	}
	paragraphs := Paragraphs(spoken)
	if err := handler.appender.Append(ctx, durationMillis, paragraphs); err != nil {
		return nil, appendFailure(err)
	}
	_ = handler.api.ReportTranscriptionProgress(ctx, 100)
	return Result{NoteItemID: source.NoteItemID, AudioItemID: source.AudioItemID, Paragraphs: len(paragraphs), DurationMillis: durationMillis}, nil
}

// fetch spools the audio to a private file. The decoder needs a file it can seek, and the
// capability Core issued is too short-lived to hold open across a long recognition.
func (handler *Handler) fetch(ctx context.Context, source *workerapi.TranscriptionSource) (string, error) {
	if source.ByteLength > handler.options.MaxBytes {
		return "", invalid("transcribe.too_large", errors.New("the recording is larger than this worker accepts"))
	}
	download, err := handler.transfer.Download(ctx, source.SourceURL, handler.options.MaxBytes)
	if err != nil {
		if errors.Is(err, objecttransfer.ErrTooLarge) {
			return "", invalid("transcribe.too_large", err)
		}
		return "", transient("transcribe.object_unavailable", err)
	}
	defer func() { _ = download.Body.Close() }()
	spool, err := worktemp.Create("nix-speech-*")
	if err != nil {
		return "", transient("transcribe.staging_unavailable", err)
	}
	path := spool.Name()
	written, copyErr := io.Copy(spool, download.Body)
	closeErr := spool.Close()
	if copyErr != nil || closeErr != nil || written != source.ByteLength {
		_ = os.Remove(path)
		if errors.Is(copyErr, objecttransfer.ErrTooLarge) {
			return "", invalid("transcribe.too_large", copyErr)
		}
		return "", transient("transcribe.object_unavailable", errors.Join(copyErr, closeErr, sizeMismatch(written, source.ByteLength)))
	}
	return path, nil
}

func sizeMismatch(written, expected int64) error {
	if written == expected {
		return nil
	}
	return fmt.Errorf("received %d of %d bytes", written, expected)
}

func (handler *Handler) limits() speechcmd.Limits {
	return speechcmd.Limits{CPUSeconds: max(1, int(handler.options.DecodeTimeout/time.Second)), MemoryBytes: 1 << 30}
}

// probeMillis is the recording's length if the file knows it, and zero if it does not.
func (handler *Handler) probeMillis(ctx context.Context, path string) int64 {
	probeContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command, err := speechcmd.Duration(probeContext, handler.options.FFprobe, path, speechcmd.Limits{CPUSeconds: 30, MemoryBytes: 1 << 30})
	if err != nil {
		return 0
	}
	output, err := command.Output()
	if err != nil {
		return 0
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return int64(seconds * 1000)
}

func (handler *Handler) recognise(ctx context.Context, path string, byChannel bool) ([]Spoken, int64, error) {
	expectedMillis := handler.probeMillis(ctx, path)
	decodeContext, cancel := context.WithTimeout(ctx, handler.options.DecodeTimeout)
	defer cancel()
	command, err := speechcmd.Decode(decodeContext, handler.options.FFmpeg, path, speechaudio.SampleRate, speechaudio.Channels, handler.limits())
	if err != nil {
		return nil, 0, transient("transcribe.decoder_unavailable", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, 0, transient("transcribe.decoder_unavailable", err)
	}
	var complaints bytes.Buffer
	command.Stderr = &limitedWriter{buffer: &complaints, limit: 4096}
	if err := command.Start(); err != nil {
		return nil, 0, transient("transcribe.decoder_unavailable", err)
	}
	stop := func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	}
	segmenter, err := speechaudio.NewSegmenter(stdout, speechaudio.DefaultLimits)
	if err != nil {
		stop()
		return nil, 0, transient("transcribe.decoder_unavailable", err)
	}

	// Running out of the time allowed for one recording is an answer about the recording, not a
	// passing fault: retried, it would hold the one recogniser for another whole allowance. So
	// every failure below is asked first whether it is really the deadline.
	timedOut := func() bool { return decodeContext.Err() != nil && ctx.Err() == nil }
	tooSlow := invalid("transcribe.timed_out", errors.New("the recording took too long to transcribe"))

	var spoken []Spoken
	var decodedMillis int64
	reported := -1
	for {
		segment, nextErr := segmenter.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			stop()
			if timedOut() {
				return nil, 0, tooSlow
			}
			return nil, 0, transient("transcribe.decode_failed", nextErr)
		}
		heard, err := handler.recogniseSegment(decodeContext, segment, byChannel)
		if err != nil {
			stop()
			if ctx.Err() != nil {
				return nil, 0, ctx.Err()
			}
			if timedOut() {
				return nil, 0, tooSlow
			}
			return nil, 0, transient("transcribe.recogniser_unavailable", err)
		}
		spoken = append(spoken, heard...)
		decodedMillis = segment.StartMillis() + segment.Millis()
		// Held under 100 until the transcript is in the note: recognised is not yet saved. A
		// report that does not get through is dropped: it is a courtesy, and the next one says more.
		if expectedMillis > 0 {
			if percent := int(min(decodedMillis*100/expectedMillis, 99)); percent > reported {
				reported = percent
				_ = handler.api.ReportTranscriptionProgress(ctx, percent)
			}
		}
	}
	if err := command.Wait(); err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		if timedOut() {
			return nil, 0, tooSlow
		}
		// Whatever decoded before the failure is not a transcript of the recording.
		return nil, 0, invalid("transcribe.decode_failed", fmt.Errorf("%w: %s", err, strings.TrimSpace(complaints.String())))
	}
	if decodedMillis == 0 {
		return nil, 0, invalid("transcribe.no_audio", errors.New("the file has no audio to transcribe"))
	}
	return spoken, decodedMillis, nil
}

func (handler *Handler) recogniseSegment(ctx context.Context, segment speechaudio.Segment, byChannel bool) ([]Spoken, error) {
	type channel struct {
		speaker Speaker
		samples []int16
	}
	var channels []channel
	// Two channels that carry the same sound are one recording played twice, whatever was asked.
	if byChannel && !segment.SameSound() {
		channels = []channel{{SpeakerMe, segment.Left}, {SpeakerOthers, segment.Right}}
	} else {
		channels = []channel{{SpeakerNone, segment.Mix()}}
	}
	var spoken []Spoken
	for _, part := range channels {
		if speechaudio.Level(part.samples) < speechaudio.QuietLevel {
			continue
		}
		utterances, err := handler.recogniser.Transcribe(ctx, whisper.Request{WAV: speechaudio.WAV(part.samples)}, false)
		if err != nil {
			return nil, err
		}
		for _, utterance := range utterances {
			spoken = append(spoken, Spoken{
				StartMillis: segment.StartMillis() + utterance.StartMillis,
				EndMillis:   segment.StartMillis() + utterance.EndMillis,
				Speaker:     part.speaker,
				Text:        utterance.Text,
			})
		}
	}
	return spoken, nil
}

type limitedWriter struct {
	buffer *bytes.Buffer
	limit  int
}

func (writer *limitedWriter) Write(data []byte) (int, error) {
	if room := writer.limit - writer.buffer.Len(); room > 0 {
		writer.buffer.Write(data[:min(room, len(data))])
	}
	return len(data), nil
}

// CollaborationClient appends a transcript through Collaboration's internal route.
type CollaborationClient struct {
	baseURL, secret string
	httpClient      *http.Client
}

func NewCollaborationClient(baseURL, secret string, timeout time.Duration) (*CollaborationClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || secret == "" || timeout <= 0 {
		return nil, errors.New("collaboration transcription client configuration is invalid")
	}
	return &CollaborationClient{
		baseURL: strings.TrimRight(baseURL, "/"), secret: secret,
		httpClient: &http.Client{Timeout: timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// AppendError is Collaboration refusing or failing an append, with the code it gave.
type AppendError struct {
	Status int
	Code   string
}

func (err *AppendError) Error() string {
	return fmt.Sprintf("collaboration refused the transcript with %d %s", err.Status, err.Code)
}

func (client *CollaborationClient) Append(ctx context.Context, durationMillis int64, paragraphs []Paragraph) error {
	if paragraphs == nil {
		paragraphs = []Paragraph{}
	}
	body, err := json.Marshal(struct {
		DurationMillis int64       `json:"durationMillis"`
		Paragraphs     []Paragraph `json:"paragraphs"`
	}{durationMillis, paragraphs})
	if err != nil {
		return err
	}
	jobID, executionID, ok := workerapi.Execution(ctx)
	if !ok {
		return errors.New("worker execution context is missing")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/internal/worker-executions/transcriptions/append", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Nix-Internal-Secret", client.secret)
	request.Header.Set("X-Nix-Worker-Job-Id", jobID)
	request.Header.Set("X-Nix-Worker-Execution-Id", executionID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	var problem struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&problem)
	return &AppendError{Status: response.StatusCode, Code: problem.Code}
}

func appendFailure(err error) error {
	var refused *AppendError
	if !errors.As(err, &refused) {
		return transient("transcribe.append_unavailable", err)
	}
	switch {
	case refused.Code == "transcription_execution_lost":
		// The lease went to somebody else; this execution has nothing left to say.
		return jobrunner.ErrCancelled
	case refused.Code == "transcription_note_locked":
		return invalid("transcribe.note_locked", err)
	case refused.Code == "transcription_note_unsupported":
		return invalid("transcribe.note_unsupported", err)
	case refused.Code == "transcription_too_large":
		return invalid("transcribe.note_too_large", err)
	case refused.Status >= 500 || refused.Status == http.StatusTooManyRequests:
		return transient("transcribe.append_unavailable", err)
	default:
		// Any other refusal is Collaboration or Core saying no for a reason that will not change.
		return invalid("transcribe.append_refused", err)
	}
}

func apiFailure(code string, err error) error {
	var response *workerapi.ResponseError
	if errors.As(err, &response) && response.Status < 500 && response.Status != http.StatusConflict {
		return invalid(code, err)
	}
	return transient(code, err)
}

func invalid(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: err.Error(), Cause: err}
}

func transient(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: err.Error(), Cause: err, Retryable: true}
}

var _ jobrunner.Handler = (*Handler)(nil)
