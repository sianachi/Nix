package objecttransfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	httpClient *http.Client
}

func New(timeout time.Duration) *Client {
	return &Client{httpClient: &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

type Download struct {
	Body   io.ReadCloser
	Digest hashReader
}

type hashReader interface {
	Sum([]byte) []byte
}

func (client *Client) Download(ctx context.Context, rawURL string, maxBytes int64) (*Download, error) {
	if maxBytes <= 0 {
		return nil, errors.New("download byte limit must be positive")
	}
	if err := validateURL(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		return nil, fmt.Errorf("source download returned %s", response.Status)
	}
	if response.ContentLength > maxBytes {
		_ = response.Body.Close()
		return nil, errors.New("source object exceeds the configured byte limit")
	}
	digest := sha256.New()
	return &Download{Body: &boundedReadCloser{reader: io.TeeReader(io.LimitReader(response.Body, maxBytes+1), digest), closer: response.Body, remaining: maxBytes}, Digest: digest}, nil
}

func (client *Client) Upload(ctx context.Context, rawURL, contentType string, body io.Reader, size int64, digest string) error {
	if size < 0 {
		return errors.New("upload size must be known")
	}
	if err := validateURL(rawURL); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, body)
	if err != nil {
		return err
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", contentType)
	if digest != "" {
		request.Header.Set("X-Nix-Content-SHA256", strings.ToLower(digest))
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("destination upload returned %s", response.Status)
	}
	return nil
}

func VerifyDigest(digest hashReader, expected string) error {
	if expected == "" {
		return nil
	}
	actual := hex.EncodeToString(digest.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return errors.New("source checksum does not match")
	}
	return nil
}

func validateURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
		return errors.New("object capability URL is invalid")
	}
	if parsed.Fragment != "" {
		return errors.New("object capability URL must not contain a fragment")
	}
	return nil
}

type boundedReadCloser struct {
	reader    io.Reader
	closer    io.Closer
	remaining int64
}

func (reader *boundedReadCloser) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	reader.remaining -= int64(count)
	if reader.remaining < 0 {
		return count, errors.New("source object exceeds the configured byte limit")
	}
	return count, err
}

func (reader *boundedReadCloser) Close() error { return reader.closer.Close() }
