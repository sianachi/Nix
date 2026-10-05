// Package whisper talks to a resident whisper.cpp server and keeps one running.
//
// The model stays loaded in that one process for as long as the speech role runs. A meeting is
// sent to it a segment at a time and a dictated clip is one more request, so the two share the
// model without either paying to load it.
package whisper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
)

// Utterance is one stretch of recognised speech, timed from the start of the clip it came from.
type Utterance struct {
	StartMillis int64
	EndMillis   int64
	Text        string
}

// Request is one clip to recognise.
type Request struct {
	// WAV is a mono 16-bit file at the recogniser's sample rate.
	WAV []byte
	// Prompt biases spelling toward names and terms the speaker is likely to use.
	Prompt string
}

// maxResponseBytes bounds what is read back for one clip; half a minute of speech is a few
// kilobytes of JSON even with word timings.
const maxResponseBytes = 4 << 20

type inferenceResponse struct {
	Error    string `json:"error"`
	Segments []struct {
		Start float64 `json:"start"`
		End   float64 `json:"end"`
		Text  string  `json:"text"`
	} `json:"segments"`
}

// Client posts clips to the server's inference route.
type Client struct {
	http *http.Client
	url  string
}

func NewClient(httpClient *http.Client, baseURL string) *Client {
	return &Client{http: httpClient, url: strings.TrimRight(baseURL, "/")}
}

// Healthy reports whether the server has loaded its model and is answering.
func (client *Client) Healthy(ctx context.Context) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.url+"/health", nil)
	if err != nil {
		return false
	}
	response, err := client.http.Do(request)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	_ = response.Body.Close()
	return response.StatusCode == http.StatusOK
}

// Transcribe recognises one clip. Silence comes back as no utterances and no error.
func (client *Client) Transcribe(ctx context.Context, clip Request) ([]Utterance, error) {
	var body bytes.Buffer
	// Sized once for the clip, so the buffer does not grow through a megabyte by doubling.
	body.Grow(len(clip.WAV) + 1024)
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "clip.wav")
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(clip.WAV); err != nil {
		return nil, err
	}
	fields := map[string]string{"response_format": "verbose_json", "temperature": "0"}
	if clip.Prompt != "" {
		fields["prompt"] = clip.Prompt
	}
	for name, value := range fields {
		if err := form.WriteField(name, value); err != nil {
			return nil, err
		}
	}
	if err := form.Close(); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.url+"/inference", &body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", form.FormDataContentType())
	response, err := client.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxResponseBytes {
		return nil, errors.New("the recogniser's answer is too large")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the recogniser answered %d", response.StatusCode)
	}
	var decoded inferenceResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("the recogniser's answer is not JSON: %w", err)
	}
	// The server reports a clip it could not read with status 200 and an error member.
	if decoded.Error != "" {
		return nil, fmt.Errorf("the recogniser refused the clip: %s", decoded.Error)
	}
	utterances := make([]Utterance, 0, len(decoded.Segments))
	for _, segment := range decoded.Segments {
		text := strings.TrimSpace(segment.Text)
		if text == "" {
			continue
		}
		utterances = append(utterances, Utterance{
			StartMillis: int64(segment.Start * 1000),
			EndMillis:   int64(segment.End * 1000),
			Text:        text,
		})
	}
	return utterances, nil
}
