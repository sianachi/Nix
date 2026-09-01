package objecttransfer

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrTooLarge      = errors.New("source object exceeds the configured byte limit")
	ErrAlreadyExists = errors.New("destination object already exists")
)

type Client struct {
	httpClient     *http.Client
	allowedOrigins map[string]struct{}
}

func New(timeout time.Duration, origins ...string) *Client {
	allowed := make(map[string]struct{}, len(origins))
	for _, value := range origins {
		if origin, err := canonicalOrigin(value); err == nil {
			allowed[origin] = struct{}{}
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	transport.ResponseHeaderTimeout = timeout
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &idleDeadlineConn{Conn: connection, timeout: timeout}, nil
	}
	return &Client{httpClient: &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     transport,
	}, allowedOrigins: allowed}
}

type Download struct {
	Body   io.ReadCloser
	Digest hashReader
}

type hashReader interface {
	Sum([]byte) []byte
}

func (client *Client) Download(ctx context.Context, rawURL string, maxBytes int64) (*Download, error) {
	return client.download(ctx, rawURL, maxBytes, "", "")
}

func (client *Client) DownloadAuthorized(ctx context.Context, rawURL string, maxBytes int64, bearerToken, internalSecret string) (*Download, error) {
	if strings.TrimSpace(bearerToken) == "" || strings.TrimSpace(internalSecret) == "" || strings.ContainsAny(bearerToken+internalSecret, "\r\n") {
		return nil, errors.New("authorized download credentials are invalid")
	}
	return client.download(ctx, rawURL, maxBytes, bearerToken, internalSecret)
}

func (client *Client) download(ctx context.Context, rawURL string, maxBytes int64, bearerToken, internalSecret string) (*Download, error) {
	if maxBytes <= 0 {
		return nil, errors.New("download byte limit must be positive")
	}
	if err := client.validateURL(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, errors.New("create source download request failed")
	}
	if bearerToken != "" {
		request.Header.Set("Authorization", "Bearer "+bearerToken)
		request.Header.Set("X-Nix-Internal-Secret", internalSecret)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, requestError("source download", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		return nil, fmt.Errorf("source download returned %s", response.Status)
	}
	if response.ContentLength > maxBytes {
		_ = response.Body.Close()
		return nil, ErrTooLarge
	}
	digest := sha256.New()
	return &Download{Body: &boundedReadCloser{reader: io.TeeReader(io.LimitReader(response.Body, maxBytes+1), digest), closer: response.Body, remaining: maxBytes}, Digest: digest}, nil
}

func (client *Client) Upload(ctx context.Context, rawURL, contentType string, body io.Reader, size int64, digest string) error {
	return client.upload(ctx, rawURL, contentType, body, size, digest, false, false)
}

func (client *Client) UploadCreateOnly(ctx context.Context, rawURL, contentType string, body io.Reader, size int64, digest string) error {
	return client.upload(ctx, rawURL, contentType, body, size, digest, true, false)
}

func (client *Client) UploadCreateOnlyVerified(ctx context.Context, rawURL, contentType string, body io.Reader, size int64, digest string) error {
	return client.upload(ctx, rawURL, contentType, body, size, digest, true, true)
}

func (client *Client) upload(ctx context.Context, rawURL, contentType string, body io.Reader, size int64, digest string, createOnly, storageChecksum bool) error {
	if size < 0 {
		return errors.New("upload size must be known")
	}
	if err := client.validateURL(rawURL); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, body)
	if err != nil {
		return errors.New("create destination upload request failed")
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", contentType)
	if createOnly {
		request.Header.Set("If-None-Match", "*")
	}
	if digest != "" {
		request.Header.Set("X-Nix-Content-SHA256", strings.ToLower(digest))
	}
	if storageChecksum {
		checksum, decodeErr := hex.DecodeString(digest)
		if decodeErr != nil || len(checksum) != sha256.Size {
			return errors.New("destination checksum is invalid")
		}
		request.Header.Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(checksum))
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return requestError("destination upload", err)
	}
	defer response.Body.Close()
	if createOnly && (response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusPreconditionFailed) {
		return ErrAlreadyExists
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("destination upload returned %s", response.Status)
	}
	return nil
}

func (client *Client) Delete(ctx context.Context, rawURL string) error {
	if err := client.validateURL(rawURL); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, rawURL, nil)
	if err != nil {
		return errors.New("create object deletion request failed")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return requestError("object deletion", err)
	}
	defer response.Body.Close()
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != http.StatusNotFound {
		return fmt.Errorf("object deletion returned %s", response.Status)
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

func (client *Client) validateURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
		return errors.New("object capability URL is invalid")
	}
	if parsed.Fragment != "" {
		return errors.New("object capability URL must not contain a fragment")
	}
	origin := strings.ToLower(parsed.Scheme + "://" + parsed.Host)
	if len(client.allowedOrigins) == 0 {
		if !loopbackHost(parsed.Hostname()) {
			return errors.New("object capability origin is not allowed")
		}
		return nil
	}
	if _, allowed := client.allowedOrigins[origin]; !allowed {
		return errors.New("object capability origin is not allowed")
	}
	return nil
}

func canonicalOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("object storage origin is invalid")
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host), nil
}

func loopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

type boundedReadCloser struct {
	reader    io.Reader
	closer    io.Closer
	remaining int64
	overflow  bool
}

func (reader *boundedReadCloser) Read(buffer []byte) (int, error) {
	if reader.overflow {
		return 0, ErrTooLarge
	}
	count, err := reader.reader.Read(buffer)
	if int64(count) > reader.remaining {
		allowed := int(reader.remaining)
		reader.remaining = 0
		reader.overflow = true
		return allowed, ErrTooLarge
	}
	reader.remaining -= int64(count)
	return count, err
}

func (reader *boundedReadCloser) Close() error { return reader.closer.Close() }

type idleDeadlineConn struct {
	net.Conn
	timeout time.Duration
}

func (connection *idleDeadlineConn) Read(buffer []byte) (int, error) {
	if err := connection.SetReadDeadline(time.Now().Add(connection.timeout)); err != nil {
		return 0, err
	}
	return connection.Conn.Read(buffer)
}

func (connection *idleDeadlineConn) Write(buffer []byte) (int, error) {
	if err := connection.SetWriteDeadline(time.Now().Add(connection.timeout)); err != nil {
		return 0, err
	}
	return connection.Conn.Write(buffer)
}

func requestError(operation string, err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("%s cancelled: %w", operation, context.Canceled)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out: %w", operation, context.DeadlineExceeded)
	}
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		return fmt.Errorf("%s failed: %w", operation, requestErr.Err)
	}
	return fmt.Errorf("%s failed", operation)
}
