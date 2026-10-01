package calendarsync

import (
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

const maxProviderResponseBytes = 1 << 20 // 1 MiB; provider event pages are bounded to <=100 events.

// transport builds the objecttransfer-style bounded, origin-locked HTTP client the plan asks for
// (exact origin allowlist, no redirects, bounded bodies, timeouts) so the Google and Microsoft
// clients can be pointed at fakes in tests and at NIX_CALENDAR_{GOOGLE,MICROSOFT}_ORIGIN in
// production, never at an arbitrary origin a compromised or misconfigured token could redirect
// them to.
type transport struct {
	origin string
	client *http.Client
}

func newTransport(origin string, timeout time.Duration) (*transport, error) {
	canonical, err := canonicalOrigin(origin)
	if err != nil {
		return nil, err
	}
	roundTripper := http.DefaultTransport.(*http.Transport).Clone()
	roundTripper.DisableCompression = true
	roundTripper.ForceAttemptHTTP2 = true
	if roundTripper.TLSClientConfig == nil {
		roundTripper.TLSClientConfig = &tls.Config{}
	}
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	roundTripper.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	}
	roundTripper.ResponseHeaderTimeout = timeout
	return &transport{
		origin: canonical,
		client: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     roundTripper,
		},
	}, nil
}

// do issues a request against a path (and optional raw query already encoded into it) under the
// configured origin, or, when rawURL is already absolute (a Graph @odata.nextLink/deltaLink),
// against that URL provided it resolves to the same allowed origin.
func (t *transport) do(ctx context.Context, method, pathOrURL string, headers map[string]string, body io.Reader) (*http.Response, error) {
	target := pathOrURL
	if !strings.HasPrefix(pathOrURL, "https://") && !strings.HasPrefix(pathOrURL, "http://") {
		target = t.origin + pathOrURL
	}
	if err := t.validateURL(target); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("build calendar provider request: %w", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := t.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("calendar provider request failed: %w", err)
	}
	return response, nil
}

func (t *transport) validateURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Scheme != "https" && parsed.Scheme != "http" {
		return errors.New("calendar provider URL is invalid")
	}
	origin := strings.ToLower(parsed.Scheme + "://" + parsed.Host)
	if origin != t.origin {
		return fmt.Errorf("calendar provider URL origin %q is not the configured origin", origin)
	}
	return nil
}

func canonicalOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("calendar provider origin %q is invalid", raw)
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host), nil
}

func readBoundedBody(body io.ReadCloser) ([]byte, error) {
	defer body.Close()
	limited := io.LimitReader(body, maxProviderResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read calendar provider response: %w", err)
	}
	if len(data) > maxProviderResponseBytes {
		return nil, errors.New("calendar provider response exceeds its size limit")
	}
	return data, nil
}
