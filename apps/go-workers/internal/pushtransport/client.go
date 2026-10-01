// Package pushtransport sends already-encrypted Web Push messages to the push
// services user agents subscribe through. Endpoints are attacker-chosen input
// (an endpoint comes from whatever push service a browser picked), so this
// client only ever talks to a small allowlist of known push-service origins,
// modelled on internal/objecttransfer's capability-URL transport: HTTPS only,
// no redirects, a bounded timeout, and a bounded response read.
package pushtransport

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// allowedOrigins are the exact push-service origins Nix subscribes to (see
// ADR-0051 section 5 and the A1 push-subscription origin allowlist). *.notify.windows.com
// is matched separately by suffix: Windows Notification Service assigns each
// subscription its own subdomain.
var allowedOrigins = map[string]struct{}{
	"fcm.googleapis.com":                {},
	"updates.push.services.mozilla.com": {},
	"web.push.apple.com":                {},
}

const notifyWindowsSuffix = ".notify.windows.com"

const maxResponseBodyBytes = 4 << 10

type Client struct {
	httpClient     *http.Client
	allowedOrigins map[string]struct{}
}

func New(timeout time.Duration) *Client {
	return newClient(timeout, allowedOrigins)
}

func newClient(timeout time.Duration, origins map[string]struct{}) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	}
	transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	transport.ResponseHeaderTimeout = timeout
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &idleDeadlineConn{Conn: connection, timeout: timeout}, nil
	}
	return &Client{
		httpClient: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     transport,
		},
		allowedOrigins: origins,
	}
}

// Send POSTs an already-encrypted Web Push message body to endpoint with the
// given headers and returns the push service's HTTP status code. The response
// body is discarded after a bounded read; callers act only on the status
// code and never trust the body of a push-service response.
func (client *Client) Send(ctx context.Context, endpoint string, headers map[string]string, body []byte) (int, error) {
	if err := client.validateEndpoint(endpoint); err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, errors.New("create push delivery request failed")
	}
	request.ContentLength = int64(len(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return 0, requestError(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBodyBytes))
	return response.StatusCode, nil
}

func (client *Client) validateEndpoint(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("push endpoint must be an HTTPS URL")
	}
	if parsed.Fragment != "" {
		return errors.New("push endpoint must not contain a fragment")
	}
	host := strings.ToLower(parsed.Hostname())
	if _, allowed := client.allowedOrigins[host]; allowed {
		return nil
	}
	if strings.HasSuffix(host, notifyWindowsSuffix) && host != notifyWindowsSuffix[1:] {
		return nil
	}
	return errors.New("push endpoint origin is not allowed")
}

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

func requestError(err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("push delivery cancelled: %w", context.Canceled)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("push delivery timed out: %w", context.DeadlineExceeded)
	}
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		return fmt.Errorf("push delivery failed: %w", requestErr.Err)
	}
	return errors.New("push delivery failed")
}
