package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProviderErrorsClassifyOnlyBoundedKnownFailuresWithoutEchoingText(t *testing.T) {
	const credit = `{"error":{"type":"invalid_request_error","message":"Your credit balance is too low. private-key-and-prompt"}}`
	for _, test := range []struct {
		name, provider, body, token string
		status                      int
		models                      bool
	}{
		{"credit", "anthropic", credit, "anthropic.credit_balance.400", 400, true},
		{"generation credit", "anthropic", credit, "anthropic.credit_balance.400", 400, false},
		{"catalog rejection", "anthropic", `{"error":{"type":"invalid_request_error","message":"private-key-and-prompt"}}`, "anthropic.models_rejected.400", 400, true},
		{"unknown generation rejection", "anthropic", `{"error":{"type":"invalid_request_error","message":"private-key-and-prompt"}}`, "", 400, false},
		{"unknown type", "anthropic", `{"error":{"type":"unknown","message":"Your credit balance is too low. private-key-and-prompt"}}`, "", 400, true},
		{"missing message", "anthropic", `{"error":{"type":"invalid_request_error"}}`, "", 400, true},
		{"malformed", "anthropic", `{"error":private-key-and-prompt`, "", 400, true},
		{"oversized", "anthropic", strings.ReplaceAll(credit, "private-key-and-prompt", strings.Repeat("private-key-and-prompt", 500)), "", 400, true},
		{"trailing oversized", "anthropic", credit + strings.Repeat(" ", 5000), "", 400, true},
		{"multiple envelopes", "anthropic", credit + credit, "", 400, true},
		{"other provider", "openrouter", credit, "", 400, true},
		{"authentication", "anthropic", "private-key-and-prompt", "anthropic.authentication.401", 401, true},
		{"permission", "anthropic", "private-key-and-prompt", "anthropic.permission.403", 403, true},
		{"rate", "openrouter", "private-key-and-prompt", "openrouter.rate_limited.429", 429, true},
		{"payment", "openrouter", "private-key-and-prompt", "openrouter.credit_balance.402", 402, true},
		{"unknown status", "anthropic", "private-key-and-prompt", "", 500, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := &boundedReader{r: strings.NewReader(test.body), limit: 1 << 20}
			err := providerResponseError(test.provider, &http.Response{StatusCode: test.status, Body: io.NopCloser(body)}, test.models)
			if token := providerFailureToken(err); token != test.token {
				t.Fatalf("code %q, want %q", token, test.token)
			}
			if body.read > 4<<10 {
				t.Fatalf("read %d bytes past error cap", body.read)
			}
			w := httptest.NewRecorder()
			writeProviderFailure(w, err)
			if w.Code != http.StatusBadGateway || w.Header().Get(providerErrorHeader) != test.token {
				t.Fatalf("wrong gateway error: %d %s", w.Code, w.Header().Get(providerErrorHeader))
			}
			if strings.Contains(err.Error()+w.Body.String(), "private-key-and-prompt") || !strings.Contains(err.Error(), "HTTP ") {
				t.Fatalf("unsafe or undiagnosable failure: %s", err)
			}
		})
	}
}

func TestARejectedModelListStopsModelsSendAndInlineBeforeGenerationWithSafeMetadata(t *testing.T) {
	for _, operation := range []string{"models", "send", "inline"} {
		t.Run(operation, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.URL.Query().Get("limit") != "100" {
					t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","message":"Your credit balance is too low. private-key-and-prompt"}}`)
			}))
			defer server.Close()
			var logs bytes.Buffer
			m, err := New(context.Background(), Options{Root: t.TempDir(), Logger: slog.New(slog.NewJSONHandler(&logs, nil))})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			m.launch = func(_ context.Context, provider, _, home, key string, notify func(string, json.RawMessage)) (Transport, error) {
				transport, err := newHTTPTransport(provider, key, home, notify)
				if err == nil {
					transport.(*httpTransport).baseURL = server.URL
				}
				return transport, err
			}
			r := request()
			r.Provider, r.ApiKey, r.Operation = "anthropic", "test-key-not-real", operation
			if operation == "inline" {
				r.InlineKind, r.SharedText = "improve", "private-inline-selection"
			}
			body, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			m.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/companion", bytes.NewReader(body)))
			if requests != 1 || w.Code != http.StatusBadGateway || w.Header().Get(providerErrorHeader) != "anthropic.credit_balance.400" {
				t.Fatalf("failure lost or generation attempted: requests=%d status=%d header=%s", requests, w.Code, w.Header().Get(providerErrorHeader))
			}
			combined := logs.String() + w.Body.String()
			if !strings.Contains(logs.String(), "HTTP 400") || !strings.Contains(logs.String(), `"operation":"`+operation+`"`) {
				t.Fatalf("safe diagnosis missing: %s", logs.String())
			}
			for _, private := range []string{"private-key-and-prompt", "test-key-not-real", "private-inline-selection", r.Text} {
				if strings.Contains(combined, private) {
					t.Fatalf("private input leaked: %s", private)
				}
			}
		})
	}
}

func TestProviderFailureNotificationsTrustOnlyMatchingFixedCodes(t *testing.T) {
	for _, token := range []string{"anthropic.credit_balance.400", "credit_balance.400", "openrouter.credit_balance.402", "anthropic.authentication.400", "anthropic.credit_balance.400,anthropic.permission.403"} {
		a := &account{provider: "anthropic", transport: &fakeTransport{}, home: t.TempDir(), conversations: map[string]*conversation{"chat": {ThreadID: "thread", State: "thinking"}}}
		turn := map[string]any{"threadId": "thread", "turn": map[string]any{"status": "failed", "error": map[string]any{"message": "private-key-and-prompt", "nixProviderError": token}}}
		raw, _ := json.Marshal(turn)
		a.notify("turn/completed", raw)
		want := "The model could not finish the response. Check account access and usage, then retry."
		if token == "anthropic.credit_balance.400" {
			want = "Claude reports that this API key has insufficient credit. Check API billing for the key, then try again."
		}
		if snapshot := a.snapshot("chat"); snapshot.Reason != want {
			t.Fatalf("notification reason %q, want %q", snapshot.Reason, want)
		}
		run := newInlineRun()
		a.registerInline("inline", run)
		turn["threadId"] = "inline"
		raw, _ = json.Marshal(turn)
		a.notify("turn/completed", raw)
		w := httptest.NewRecorder()
		a.pumpInline(context.Background(), w, w, run, "inline", "turn", time.Now())
		if strings.Contains(w.Body.String(), "private-key-and-prompt") || !strings.Contains(w.Body.String(), "inline.provider_failed") {
			t.Fatalf("unsafe inline failure: %s", w.Body.String())
		}
	}
}
