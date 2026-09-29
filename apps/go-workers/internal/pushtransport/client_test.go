package pushtransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateEndpointAllowsExactAllowlistedOrigins(t *testing.T) {
	client := New(time.Second)
	for _, endpoint := range []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://web.push.apple.com/abc",
	} {
		if err := client.validateEndpoint(endpoint); err != nil {
			t.Errorf("expected %q to be allowed, got %v", endpoint, err)
		}
	}
}

func TestValidateEndpointAllowsNotifyWindowsSubdomains(t *testing.T) {
	client := New(time.Second)
	if err := client.validateEndpoint("https://sn1.notify.windows.com/w/abc"); err != nil {
		t.Errorf("expected a *.notify.windows.com subdomain to be allowed, got %v", err)
	}
	if err := client.validateEndpoint("https://notify.windows.com/w/abc"); err == nil {
		t.Error("the bare notify.windows.com host must not match the subdomain suffix rule")
	}
}

func TestValidateEndpointRejectsUnknownOrigins(t *testing.T) {
	client := New(time.Second)
	for _, endpoint := range []string{
		"https://evil.example.com/fcm/send/abc",
		"http://fcm.googleapis.com/fcm/send/abc",
		"https://fcm.googleapis.com.evil.example.com/fcm/send/abc",
		"https://fcm.googleapis.com/fcm/send/abc#fragment",
		"https://user:pass@fcm.googleapis.com/fcm/send/abc",
		"not-a-url",
	} {
		if err := client.validateEndpoint(endpoint); err == nil {
			t.Errorf("expected %q to be rejected", endpoint)
		}
	}
}

func TestSendReturnsStatusAndDoesNotFollowRedirects(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "vapid t=x, k=y" {
			t.Errorf("expected the Authorization header to be forwarded, got %q", request.Header.Get("Authorization"))
		}
		http.Redirect(response, request, "/somewhere-else", http.StatusFound)
	}))
	defer server.Close()

	client := newClient(2*time.Second, map[string]struct{}{hostOf(t, server.URL): {}})
	client.httpClient.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = true

	status, err := client.Send(context.Background(), server.URL, map[string]string{"Authorization": "vapid t=x, k=y"}, []byte("body"))
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if status != http.StatusFound {
		t.Fatalf("expected the redirect status to be surfaced rather than followed, got %d", status)
	}
}

func TestSendRejectsDisallowedOrigin(t *testing.T) {
	client := New(time.Second)
	if _, err := client.Send(context.Background(), "https://evil.example.com/x", nil, []byte("body")); err == nil {
		t.Fatal("expected an unlisted origin to be rejected before any request is made")
	}
}

func hostOf(t *testing.T, rawURL string) string {
	t.Helper()
	host := strings.TrimPrefix(rawURL, "https://")
	if index := strings.IndexByte(host, ':'); index >= 0 {
		host = host[:index]
	}
	return host
}
