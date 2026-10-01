package notifyjob

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// fakeCore is an httptest fake of Nix.Api's N1 worker-execution endpoints
// (POST .../delivery and POST .../delivery/results), standing in for the
// Core lane (A2) this worker is coded against by contract alone.
type fakeCore struct {
	server *httptest.Server

	mu       sync.Mutex
	delivery workerapi.NotificationDelivery
	results  []workerapi.NotificationDeliveryResult
	reported bool
	secret   string
	notifyID string
}

func newFakeCore(t *testing.T, notifyID, secret string, delivery workerapi.NotificationDelivery) *fakeCore {
	t.Helper()
	fake := &fakeCore{delivery: delivery, secret: secret, notifyID: notifyID}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/worker-executions/notifications/{id}/delivery", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Internal-Secret") != fake.secret {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		if request.PathValue("id") != fake.notifyID {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(fake.delivery)
	})
	mux.HandleFunc("POST /internal/worker-executions/notifications/{id}/delivery/results", func(response http.ResponseWriter, request *http.Request) {
		if request.PathValue("id") != fake.notifyID {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Results []workerapi.NotificationDeliveryResult `json:"results"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		fake.mu.Lock()
		fake.results = body.Results
		fake.reported = true
		fake.mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

func (fake *fakeCore) reportedResults() ([]workerapi.NotificationDeliveryResult, bool) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.results, fake.reported
}

// fakeTransport stands in for the push service HTTP boundary: it records
// what notifyjob would have sent and returns a scripted per-endpoint status.
type fakeTransport struct {
	mu     sync.Mutex
	sent   map[string][]byte
	sends  map[string]map[string]string
	status map[string]int
	err    map[string]error
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{
		sent:   make(map[string][]byte),
		sends:  make(map[string]map[string]string),
		status: make(map[string]int),
		err:    make(map[string]error),
	}
}

func (fake *fakeTransport) Send(_ context.Context, endpoint string, headers map[string]string, body []byte) (int, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.sent[endpoint] = append([]byte(nil), body...)
	fake.sends[endpoint] = headers
	if err, ok := fake.err[endpoint]; ok {
		return 0, err
	}
	if status, ok := fake.status[endpoint]; ok {
		return status, nil
	}
	return http.StatusCreated, nil
}

func generateSubscriptionKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate subscription key: %v", err)
	}
	authBytes := make([]byte, 16)
	if _, err := rand.Read(authBytes); err != nil {
		t.Fatalf("generate auth secret: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), base64.RawURLEncoding.EncodeToString(authBytes)
}

func generateVAPIDKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate VAPID key: %v", err)
	}
	return key
}

func TestHandleDeliversToEverySubscriptionAndReportsResults(t *testing.T) {
	notifyID := "11111111-1111-4111-8111-111111111111"
	subscriptionOK := "22222222-2222-4222-8222-222222222222"
	subscriptionGone := "33333333-3333-4333-8333-333333333333"
	p256dhOK, authOK := generateSubscriptionKeys(t)
	p256dhGone, authGone := generateSubscriptionKeys(t)

	delivery := workerapi.NotificationDelivery{
		Payload: workerapi.NotificationDeliveryPayload{Title: "Reminder", Body: "Water the plants", URL: "/items/abc", Tag: "reminder:abc"},
		Subscriptions: []workerapi.NotificationDeliverySubscription{
			{ID: subscriptionOK, Endpoint: "https://fcm.googleapis.com/fcm/send/ok", P256dh: p256dhOK, Auth: authOK},
			{ID: subscriptionGone, Endpoint: "https://fcm.googleapis.com/fcm/send/gone", P256dh: p256dhGone, Auth: authGone},
		},
	}
	core := newFakeCore(t, notifyID, "test-secret", delivery)
	api := workerapi.New(core.server.URL, "test-secret", "worker-1", 5*time.Second)

	transport := newFakeTransport()
	transport.status["https://fcm.googleapis.com/fcm/send/ok"] = http.StatusCreated
	transport.status["https://fcm.googleapis.com/fcm/send/gone"] = http.StatusGone

	handler := New(api, transport, generateVAPIDKey(t), "mailto:push@example.com")
	job := workerapi.Job{ID: notifyID, Kind: "notify.push", Payload: json.RawMessage(`{"notificationId":"` + notifyID + `"}`)}

	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	typed, ok := result.(Result)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if typed.Delivered != 1 || typed.Gone != 1 || typed.Failed != 0 {
		t.Fatalf("unexpected tally: %+v", typed)
	}

	results, reported := core.reportedResults()
	if !reported {
		t.Fatal("expected results to be reported to N1")
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	byID := map[string]workerapi.NotificationDeliveryResult{}
	for _, entry := range results {
		byID[entry.SubscriptionID] = entry
	}
	if byID[subscriptionOK].Status != "delivered" || byID[subscriptionOK].HTTPStatus != http.StatusCreated {
		t.Fatalf("unexpected ok result: %+v", byID[subscriptionOK])
	}
	if byID[subscriptionGone].Status != "gone" || byID[subscriptionGone].HTTPStatus != http.StatusGone {
		t.Fatalf("unexpected gone result: %+v", byID[subscriptionGone])
	}

	sentBody, ok := transport.sent["https://fcm.googleapis.com/fcm/send/ok"]
	if !ok || len(sentBody) == 0 {
		t.Fatal("expected an encrypted body to have been sent")
	}
	headers := transport.sends["https://fcm.googleapis.com/fcm/send/ok"]
	if headers["Content-Encoding"] != "aes128gcm" {
		t.Fatalf("unexpected Content-Encoding: %q", headers["Content-Encoding"])
	}
	if !strings.HasPrefix(headers["Authorization"], "vapid t=") {
		t.Fatalf("unexpected Authorization header: %q", headers["Authorization"])
	}
	if headers["TTL"] != "86400" {
		t.Fatalf("unexpected TTL header: %q", headers["TTL"])
	}
}

func TestHandleTreatsAnInvalidSubscriptionAsFailedNotAsAJobFailure(t *testing.T) {
	notifyID := "44444444-4444-4444-8444-444444444444"
	subscriptionBad := "55555555-5555-4555-8555-555555555555"
	delivery := workerapi.NotificationDelivery{
		Payload: workerapi.NotificationDeliveryPayload{Title: "Reminder", Body: "Water the plants", URL: "/items/abc", Tag: "reminder:abc"},
		Subscriptions: []workerapi.NotificationDeliverySubscription{
			{ID: subscriptionBad, Endpoint: "https://fcm.googleapis.com/fcm/send/bad", P256dh: "not-base64!!", Auth: "also-not-base64!!"},
		},
	}
	core := newFakeCore(t, notifyID, "test-secret", delivery)
	api := workerapi.New(core.server.URL, "test-secret", "worker-1", 5*time.Second)
	transport := newFakeTransport()
	handler := New(api, transport, generateVAPIDKey(t), "mailto:push@example.com")
	job := workerapi.Job{ID: notifyID, Kind: "notify.push", Payload: json.RawMessage(`{"notificationId":"` + notifyID + `"}`)}

	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	typed := result.(Result)
	if typed.Failed != 1 || typed.Delivered != 0 || typed.Gone != 0 {
		t.Fatalf("unexpected tally: %+v", typed)
	}
	if len(transport.sent) != 0 {
		t.Fatal("expected no push message to have been sent for an undecodable subscription")
	}
}

func TestHandleRejectsAKindMismatch(t *testing.T) {
	notifyID := "66666666-6666-4666-8666-666666666666"
	handler := New(workerapi.New("http://127.0.0.1:0", "secret", "worker-1", time.Second), newFakeTransport(), generateVAPIDKey(t), "mailto:push@example.com")
	job := workerapi.Job{ID: notifyID, Kind: "notify.other", Payload: json.RawMessage(`{"notificationId":"` + notifyID + `"}`)}
	if _, err := handler.Handle(context.Background(), job); err == nil {
		t.Fatal("expected a job kind mismatch to be rejected")
	}
}

func TestHandleRejectsAnInvalidPayload(t *testing.T) {
	handler := New(workerapi.New("http://127.0.0.1:0", "secret", "worker-1", time.Second), newFakeTransport(), generateVAPIDKey(t), "mailto:push@example.com")
	job := workerapi.Job{ID: "not-a-uuid", Kind: "notify.push", Payload: json.RawMessage(`{"notificationId":"not-a-uuid"}`)}
	if _, err := handler.Handle(context.Background(), job); err == nil {
		t.Fatal("expected an invalid notification id to be rejected")
	}
}
