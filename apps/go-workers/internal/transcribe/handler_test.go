package transcribe

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/whisper"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// stereoWAV is a 16 kHz stereo file with a tone of the given level on each channel.
func stereoWAV(seconds int, leftLevel, rightLevel float64, rightHertz float64) []byte {
	const rate = 16000
	frames := seconds * rate
	data := make([]byte, 0, frames*4)
	for index := range frames {
		at := float64(index) / rate
		left := int16(leftLevel * 30000 * math.Sin(2*math.Pi*440*at))
		right := int16(rightLevel * 30000 * math.Sin(2*math.Pi*rightHertz*at))
		data = binary.LittleEndian.AppendUint16(data, uint16(left))
		data = binary.LittleEndian.AppendUint16(data, uint16(right))
	}
	header := make([]byte, 44)
	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(36+len(data)))
	copy(header[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1)
	binary.LittleEndian.PutUint16(header[22:24], 2)
	binary.LittleEndian.PutUint32(header[24:28], rate)
	binary.LittleEndian.PutUint32(header[28:32], rate*4)
	binary.LittleEndian.PutUint16(header[32:34], 4)
	binary.LittleEndian.PutUint16(header[34:36], 16)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], uint32(len(data)))
	return append(header, data...)
}

type fakeAPI struct {
	source   workerapi.TranscriptionSource
	err      error
	mu       sync.Mutex
	progress []int
}

func (api *fakeAPI) GetTranscriptionSource(context.Context) (*workerapi.TranscriptionSource, error) {
	if api.err != nil {
		return nil, api.err
	}
	source := api.source
	return &source, nil
}

func (api *fakeAPI) ReportTranscriptionProgress(_ context.Context, percent int) error {
	api.mu.Lock()
	defer api.mu.Unlock()
	api.progress = append(api.progress, percent)
	return nil
}

// fakeRecogniser answers every clip with one utterance and remembers that it was patient.
type fakeRecogniser struct {
	calls  int
	urgent bool
	err    error
}

func (recogniser *fakeRecogniser) Transcribe(_ context.Context, clip whisper.Request, urgent bool) ([]whisper.Utterance, error) {
	recogniser.calls++
	recogniser.urgent = recogniser.urgent || urgent
	if recogniser.err != nil {
		return nil, recogniser.err
	}
	if !bytes.HasPrefix(clip.WAV, []byte("RIFF")) {
		return nil, errors.New("the clip is not a WAV file")
	}
	return []whisper.Utterance{{StartMillis: 500, EndMillis: 1500, Text: "hello there."}}, nil
}

type fakeAppender struct {
	duration   int64
	paragraphs []Paragraph
	calls      int
	err        error
}

func (appender *fakeAppender) Append(_ context.Context, durationMillis int64, paragraphs []Paragraph) error {
	appender.calls++
	appender.duration, appender.paragraphs = durationMillis, paragraphs
	return appender.err
}

type fixture struct {
	handler    *Handler
	api        *fakeAPI
	recogniser *fakeRecogniser
	appender   *fakeAppender
}

func newFixture(t *testing.T, audio []byte, speakers string) *fixture {
	t.Helper()
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	store := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(audio)
	}))
	t.Cleanup(store.Close)
	api := &fakeAPI{source: workerapi.TranscriptionSource{
		SourceURL: store.URL + "/recording", ByteLength: int64(len(audio)),
		AudioItemID: "audio", NoteItemID: "note", WorkspaceID: "workspace", Speakers: speakers,
	}}
	recogniser, appender := &fakeRecogniser{}, &fakeAppender{}
	handler, err := New(api, objecttransfer.New(10*time.Second, store.URL), recogniser, appender, Options{
		FFmpeg: "ffmpeg", FFprobe: "ffprobe", MaxBytes: 64 << 20, DecodeTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{handler: handler, api: api, recogniser: recogniser, appender: appender}
}

var job = workerapi.Job{Kind: Kind, Payload: json.RawMessage(`{}`)}

func TestARecordingWithTwoChannelsIsTranscribedBySpeaker(t *testing.T) {
	fixture := newFixture(t, stereoWAV(3, 0.5, 0.5, 880), "channels")

	result, err := fixture.handler.Handle(context.Background(), job)

	if err != nil {
		t.Fatal(err)
	}
	if result != (Result{NoteItemID: "note", AudioItemID: "audio", Paragraphs: 2, DurationMillis: 3000}) {
		t.Fatalf("result = %#v", result)
	}
	if fixture.recogniser.calls != 2 || fixture.recogniser.urgent {
		t.Fatalf("recogniser calls = %d, urgent = %v", fixture.recogniser.calls, fixture.recogniser.urgent)
	}
	want := []Paragraph{
		{StartMillis: 500, Speaker: SpeakerMe, Text: "hello there."},
		{StartMillis: 500, Speaker: SpeakerOthers, Text: "hello there."},
	}
	if len(fixture.appender.paragraphs) != 2 || fixture.appender.paragraphs[0] != want[0] || fixture.appender.paragraphs[1] != want[1] {
		t.Fatalf("paragraphs = %#v", fixture.appender.paragraphs)
	}
	if fixture.appender.duration != 3000 {
		t.Fatalf("duration = %d", fixture.appender.duration)
	}
	if last := fixture.api.progress[len(fixture.api.progress)-1]; last != 100 {
		t.Fatalf("progress = %v", fixture.api.progress)
	}
}

func TestOneSoundOnBothChannelsIsNotSplitAndASilentChannelIsSkipped(t *testing.T) {
	same := newFixture(t, stereoWAV(2, 0.5, 0.5, 440), "channels")
	if _, err := same.handler.Handle(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if same.recogniser.calls != 1 || same.appender.paragraphs[0].Speaker != SpeakerNone {
		t.Fatalf("calls = %d, paragraphs = %#v", same.recogniser.calls, same.appender.paragraphs)
	}

	quietTab := newFixture(t, stereoWAV(2, 0.5, 0, 880), "channels")
	if _, err := quietTab.handler.Handle(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if quietTab.recogniser.calls != 1 || quietTab.appender.paragraphs[0].Speaker != SpeakerMe {
		t.Fatalf("calls = %d, paragraphs = %#v", quietTab.recogniser.calls, quietTab.appender.paragraphs)
	}

	mixed := newFixture(t, stereoWAV(2, 0.5, 0.5, 880), "none")
	if _, err := mixed.handler.Handle(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if mixed.recogniser.calls != 1 || mixed.appender.paragraphs[0].Speaker != SpeakerNone {
		t.Fatalf("calls = %d, paragraphs = %#v", mixed.recogniser.calls, mixed.appender.paragraphs)
	}
}

func TestSilenceIsAnEmptyTranscriptNotAFailure(t *testing.T) {
	fixture := newFixture(t, stereoWAV(2, 0, 0, 440), "none")

	result, err := fixture.handler.Handle(context.Background(), job)

	if err != nil || fixture.recogniser.calls != 0 || fixture.appender.calls != 1 || len(fixture.appender.paragraphs) != 0 {
		t.Fatalf("result = %#v, err = %v, calls = %d", result, err, fixture.recogniser.calls)
	}
}

func jobError(t *testing.T, err error) *jobrunner.JobError {
	t.Helper()
	var typed *jobrunner.JobError
	if !errors.As(err, &typed) {
		t.Fatalf("err = %v", err)
	}
	return typed
}

func TestNothingIsWrittenWhenTheRecordingCannotBeTranscribed(t *testing.T) {
	notAudio := newFixture(t, []byte("this is not audio at all"), "none")
	_, err := notAudio.handler.Handle(context.Background(), job)
	if typed := jobError(t, err); typed.Code != "transcribe.decode_failed" || typed.Retryable || notAudio.appender.calls != 0 {
		t.Fatalf("err = %#v, appends = %d", typed, notAudio.appender.calls)
	}

	down := newFixture(t, stereoWAV(1, 0.5, 0.5, 440), "none")
	down.recogniser.err = whisper.ErrNotReady
	_, err = down.handler.Handle(context.Background(), job)
	if typed := jobError(t, err); typed.Code != "transcribe.recogniser_unavailable" || !typed.Retryable || down.appender.calls != 0 {
		t.Fatalf("err = %#v", typed)
	}

	oversized := newFixture(t, stereoWAV(1, 0.5, 0.5, 440), "none")
	oversized.api.source.ByteLength = 65 << 20
	_, err = oversized.handler.Handle(context.Background(), job)
	if typed := jobError(t, err); typed.Code != "transcribe.too_large" || typed.Retryable {
		t.Fatalf("err = %#v", typed)
	}

	gone := newFixture(t, stereoWAV(1, 0.5, 0.5, 440), "none")
	gone.api.err = &workerapi.ResponseError{Status: http.StatusNotFound, Path: "/source"}
	_, err = gone.handler.Handle(context.Background(), job)
	if typed := jobError(t, err); typed.Code != "transcribe.source_unavailable" || typed.Retryable {
		t.Fatalf("err = %#v", typed)
	}

	if _, err := gone.handler.Handle(context.Background(), workerapi.Job{Kind: "file.publish"}); jobError(t, err).Code != "transcribe.kind_mismatch" {
		t.Fatalf("err = %v", err)
	}
}

func TestARefusedAppendIsClassifiedByItsCode(t *testing.T) {
	cases := []struct {
		err       error
		code      string
		retryable bool
	}{
		{&AppendError{Status: 409, Code: "transcription_note_locked"}, "transcribe.note_locked", false},
		{&AppendError{Status: 409, Code: "transcription_note_unsupported"}, "transcribe.note_unsupported", false},
		{&AppendError{Status: 413, Code: "transcription_too_large"}, "transcribe.note_too_large", false},
		{&AppendError{Status: 503, Code: "transcription_core_unavailable"}, "transcribe.append_unavailable", true},
		{&AppendError{Status: 404, Code: "transcription_not_found"}, "transcribe.append_refused", false},
		{errors.New("connection reset"), "transcribe.append_unavailable", true},
	}
	for _, test := range cases {
		if typed := jobError(t, appendFailure(test.err)); typed.Code != test.code || typed.Retryable != test.retryable {
			t.Fatalf("%v classified as %#v", test.err, typed)
		}
	}
	if err := appendFailure(&AppendError{Status: 409, Code: "transcription_execution_lost"}); !errors.Is(err, jobrunner.ErrCancelled) {
		t.Fatalf("err = %v", err)
	}
}

func TestTheCollaborationClientSendsTheExecutionAndReadsTheRefusal(t *testing.T) {
	var headers http.Header
	var body struct {
		DurationMillis int64       `json:"durationMillis"`
		Paragraphs     []Paragraph `json:"paragraphs"`
	}
	status := http.StatusOK
	collab := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		headers = request.Header
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &body)
		if request.URL.Path != "/internal/worker-executions/transcriptions/append" {
			status = http.StatusNotFound
		}
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, `{"code":"transcription_note_locked"}`)
	}))
	defer collab.Close()
	client, err := NewCollaborationClient(collab.URL, "secret", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx := workerapi.WithExecution(context.Background(), "job-1", "execution-1")

	if err := client.Append(ctx, 9000, nil); err != nil {
		t.Fatal(err)
	}
	if headers.Get("X-Nix-Internal-Secret") != "secret" || headers.Get("X-Nix-Worker-Job-Id") != "job-1" || headers.Get("X-Nix-Worker-Execution-Id") != "execution-1" {
		t.Fatalf("headers = %v", headers)
	}
	// An empty transcript is an empty list, never null: the route validates an array.
	if body.DurationMillis != 9000 || body.Paragraphs == nil {
		t.Fatalf("body = %#v", body)
	}

	status = http.StatusConflict
	var refused *AppendError
	if err := client.Append(ctx, 1, []Paragraph{{Text: "x"}}); !errors.As(err, &refused) || refused.Code != "transcription_note_locked" || refused.Status != 409 {
		t.Fatalf("err = %v", err)
	}
	if err := client.Append(context.Background(), 1, nil); err == nil {
		t.Fatal("an append outside a job execution was sent")
	}
	if _, err := NewCollaborationClient("ftp://collab", "secret", time.Second); err == nil {
		t.Fatal("an invalid collaboration URL was accepted")
	}
}

// The append request is the worker's half of fixture t4, which Collaboration's tests accept.
func TestTheAppendRequestMatchesTheSharedContract(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("..", "workerapi", "testdata", "speech", "t4_append_request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want bytes.Buffer
	if err := json.Compact(&want, fixture); err != nil {
		t.Fatal(err)
	}
	var sent []byte
	collab := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		sent, _ = io.ReadAll(request.Body)
	}))
	defer collab.Close()
	client, _ := NewCollaborationClient(collab.URL, "secret", time.Second)

	err = client.Append(workerapi.WithExecution(context.Background(), "job", "execution"), 61000, []Paragraph{
		{StartMillis: 0, Speaker: SpeakerMe, Text: "Shall we start?"},
		{StartMillis: 4200, Speaker: SpeakerOthers, Text: "Yes, go ahead."},
		{StartMillis: 30500, Speaker: SpeakerNone, Text: "A line with no speaker."},
	})

	if err != nil || !bytes.Equal(sent, want.Bytes()) {
		t.Fatalf("err = %v, sent %s", err, sent)
	}
}

// blockingRecogniser never answers: it waits for its caller to give up.
type blockingRecogniser struct{}

func (blockingRecogniser) Transcribe(ctx context.Context, _ whisper.Request, _ bool) ([]whisper.Utterance, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestARecordingThatRunsOutOfTimeFailsForGoodAndIsNotRetried(t *testing.T) {
	fixture := newFixture(t, stereoWAV(2, 0.5, 0.5, 440), "none")
	fixture.handler.recogniser = blockingRecogniser{}
	fixture.handler.options.DecodeTimeout = 150 * time.Millisecond

	_, err := fixture.handler.Handle(context.Background(), job)

	if typed := jobError(t, err); typed.Code != "transcribe.timed_out" || typed.Retryable || fixture.appender.calls != 0 {
		t.Fatalf("err = %#v, appends = %d", typed, fixture.appender.calls)
	}
}

func TestACancelledJobIsCancelledAndNotCalledSlow(t *testing.T) {
	fixture := newFixture(t, stereoWAV(2, 0.5, 0.5, 440), "none")
	fixture.handler.recogniser = blockingRecogniser{}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	_, err := fixture.handler.Handle(ctx, job)

	var typed *jobrunner.JobError
	if err == nil || errors.As(err, &typed) {
		t.Fatalf("err = %v", err)
	}
}

func TestProgressOnlyRisesAndReachesAHundredOnceTheTranscriptIsIn(t *testing.T) {
	fixture := newFixture(t, stereoWAV(70, 0.5, 0.5, 440), "none")

	if _, err := fixture.handler.Handle(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	reports := fixture.api.progress
	if len(reports) < 3 || reports[len(reports)-1] != 100 {
		t.Fatalf("progress = %v", reports)
	}
	for index := 1; index < len(reports); index++ {
		if reports[index] <= reports[index-1] {
			t.Fatalf("progress went from %d to %d", reports[index-1], reports[index])
		}
		if index < len(reports)-1 && reports[index] > 99 {
			t.Fatalf("progress reached %d before the transcript was appended", reports[index])
		}
	}
	// Seventy seconds is three segments, none longer than the recogniser's window.
	if fixture.recogniser.calls != 3 {
		t.Fatalf("segments = %d", fixture.recogniser.calls)
	}
}
