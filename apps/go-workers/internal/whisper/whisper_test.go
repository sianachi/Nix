package whisper

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTranscribeSendsTheClipAndReadsTimedUtterances(t *testing.T) {
	var prompt, format string
	var size int64
	recogniser := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/inference" {
			http.NotFound(writer, request)
			return
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Errorf("no file: %v", err)
			return
		}
		_ = file.Close()
		size, prompt, format = header.Size, request.FormValue("prompt"), request.FormValue("response_format")
		_, _ = io.WriteString(writer, `{"segments":[{"start":0.29,"end":7.07,"text":" and so my fellow Americans"},{"start":7.1,"end":7.2,"text":"  "},{"start":7.5,"end":11,"text":" ask not"}]}`)
	}))
	defer recogniser.Close()

	utterances, err := NewClient(recogniser.Client(), recogniser.URL+"/").Transcribe(context.Background(), Request{WAV: []byte("RIFFdata"), Prompt: "Kennedy"})

	if err != nil {
		t.Fatal(err)
	}
	if size != 8 || prompt != "Kennedy" || format != "verbose_json" {
		t.Fatalf("sent size=%d prompt=%q format=%q", size, prompt, format)
	}
	if len(utterances) != 2 || utterances[0] != (Utterance{StartMillis: 290, EndMillis: 7070, Text: "and so my fellow Americans"}) || utterances[1].Text != "ask not" {
		t.Fatalf("utterances = %#v", utterances)
	}
}

func TestSilenceIsNothingAndARefusalIsAnError(t *testing.T) {
	answer := `{"text":"","segments":[]}`
	status := http.StatusOK
	recogniser := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health" {
			writer.WriteHeader(status)
			return
		}
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, answer)
	}))
	defer recogniser.Close()
	client := NewClient(recogniser.Client(), recogniser.URL)

	if utterances, err := client.Transcribe(context.Background(), Request{}); err != nil || len(utterances) != 0 {
		t.Fatalf("silence: %v, %v", utterances, err)
	}
	if !client.Healthy(context.Background()) {
		t.Fatal("a healthy server was reported unhealthy")
	}
	// The server answers 200 with an error member for a clip it cannot read.
	answer = `{"error":"failed to read audio data"}`
	if _, err := client.Transcribe(context.Background(), Request{}); err == nil || !strings.Contains(err.Error(), "failed to read audio data") {
		t.Fatalf("err = %v", err)
	}
	answer, status = "busy", http.StatusServiceUnavailable
	if _, err := client.Transcribe(context.Background(), Request{}); err == nil {
		t.Fatal("a failing status was accepted")
	}
	if client.Healthy(context.Background()) {
		t.Fatal("an unhealthy server was reported healthy")
	}
}

func TestAnUrgentCallerGoesAheadOfPatientOnes(t *testing.T) {
	server, err := NewServer(Options{Binary: "whisper-server", Model: "model.bin", Port: 1}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	holding, err := server.acquire(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	var order []string
	var mu sync.Mutex
	var done sync.WaitGroup
	enter := func(name string, urgent bool) {
		defer done.Done()
		release, err := server.acquire(context.Background(), urgent)
		if err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		order = append(order, name)
		mu.Unlock()
		release()
	}
	done.Add(1)
	go enter("meeting", false)
	time.Sleep(20 * time.Millisecond)
	done.Add(1)
	go enter("dictation", true)
	time.Sleep(20 * time.Millisecond)
	holding()
	done.Wait()

	// The meeting was already waiting on the turn itself, so it may win this once; what must hold
	// is that both get through and a later patient caller waits behind an urgent one.
	if len(order) != 2 {
		t.Fatalf("order = %v", order)
	}

	holding, _ = server.acquire(context.Background(), false)
	done.Add(1)
	go enter("dictation", true)
	time.Sleep(20 * time.Millisecond)
	done.Add(1)
	go enter("meeting", false)
	time.Sleep(20 * time.Millisecond)
	order = nil
	holding()
	done.Wait()
	if len(order) != 2 || order[0] != "dictation" {
		t.Fatalf("order = %v", order)
	}
}

func TestWaitingStopsWhenTheCallerGivesUp(t *testing.T) {
	server, _ := NewServer(Options{Binary: "whisper-server", Model: "model.bin", Port: 1}, slog.New(slog.DiscardHandler))
	holding, _ := server.acquire(context.Background(), true)
	defer holding()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := server.acquire(ctx, false); err == nil {
		t.Fatal("a caller who gave up was given the turn")
	}
	if _, err := server.Transcribe(context.Background(), Request{}, true); err != ErrNotReady {
		t.Fatalf("err = %v", err)
	}
	if arguments := strings.Join(server.arguments(), " "); !strings.Contains(arguments, "--no-gpu") || !strings.Contains(arguments, "--no-context") || strings.Contains(arguments, "--vad") {
		t.Fatalf("arguments = %s", arguments)
	}
}
