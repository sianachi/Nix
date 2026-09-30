package workerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The fixtures under testdata/calendar are the shared C1-C6 contract with Core's
// CalendarWorkerContractTests: Core posts the request fixtures and asserts its responses carry
// exactly the fixture key sets, and these tests prove the worker writes byte-identical requests
// and strictly decodes the responses. Changing a fixture changes the contract on both sides.

const contractLinkID = "55555555-5555-4555-8555-555555555555"

func readCalendarFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "calendar", name+".json"))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		t.Fatalf("compact fixture %s: %v", name, err)
	}
	return compact.Bytes()
}

// contractCore serves the C1-C6 routes: the response routes answer with the fixtures and every
// request body is recorded by route suffix.
type contractCore struct {
	mu     sync.Mutex
	bodies map[string][]byte
}

func newContractCore(t *testing.T) (*contractCore, *Client) {
	t.Helper()
	core := &contractCore{bodies: map[string][]byte{}}
	prefix := "/internal/worker-executions/calendar/links/" + contractLinkID + "/"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		route := strings.TrimPrefix(r.URL.Path, prefix)
		body, _ := io.ReadAll(r.Body)
		core.mu.Lock()
		core.bodies[route] = body
		core.mu.Unlock()
		switch route {
		case "session":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(readCalendarFixture(t, "c1_session_response"))
		case "pull":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"applied":3,"conflicts":0}`))
		case "changes":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(readCalendarFixture(t, "c3_changes_response"))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(server.Close)
	return core, New(server.URL, "test-secret", "test-worker", 5*time.Second)
}

func (core *contractCore) body(route string) []byte {
	core.mu.Lock()
	defer core.mu.Unlock()
	return bytes.TrimRight(core.bodies[route], "\n")
}

func requireSameJSON(t *testing.T, fixture string, got []byte) {
	t.Helper()
	want := readCalendarFixture(t, fixture)
	if !bytes.Equal(want, got) {
		t.Fatalf("%s mismatch\nwant %s\ngot  %s", fixture, want, got)
	}
}

func contractTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

func TestCalendarContractC1SessionResponseDecodesStrictly(t *testing.T) {
	_, client := newContractCore(t)
	session, err := client.StartCalendarSession(context.Background(), contractLinkID)
	if err != nil {
		t.Fatalf("StartCalendarSession: %v", err)
	}
	if session.Provider != "google" || session.ExternalCalendarID != "primary" || session.Direction != "two_way" ||
		session.Cursor != nil || session.AccessToken != "fixture-access-token" ||
		!session.WindowStart.Equal(contractTime(t, "2026-08-31T00:00:00Z")) ||
		!session.WindowEnd.Equal(contractTime(t, "2027-10-01T00:00:00Z")) {
		t.Fatalf("session = %+v", session)
	}
	// Re-encoding the decoded value must reproduce the fixture exactly: every fixture key is a
	// field and every field is a fixture key.
	encoded, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal session: %v", err)
	}
	requireSameJSON(t, "c1_session_response", encoded)
}

func TestCalendarContractC2PullRequestMatchesFixture(t *testing.T) {
	core, client := newContractCore(t)
	timedEnd := "2026-10-01T09:15:00-04:00[America/New_York]"
	allDayEnd := "2026-10-06"
	request := CalendarPullRequest{Full: false, Events: []CalendarEvent{
		{
			ExternalID: "evt-timed", Version: `"3181161784712000"`, Status: "confirmed", Title: "Standup",
			Start: "2026-10-01T09:00:00-04:00[America/New_York]", End: &timedEnd,
			Location: "Room 4", Details: "Agenda\nNotes", ReadOnly: false,
			UpdatedAt: contractTime(t, "2026-09-30T12:00:00Z"),
		},
		{
			ExternalID: "evt-allday", Version: "ck-2", Status: "confirmed", Title: "Offsite",
			Start: "2026-10-05", End: &allDayEnd, ReadOnly: true,
			UpdatedAt: contractTime(t, "2026-09-29T08:30:00Z"),
		},
		{
			ExternalID: "evt-cancelled", Status: "cancelled",
			UpdatedAt: contractTime(t, "2026-09-30T12:05:00Z"),
		},
	}}
	result, err := client.PullCalendarEvents(context.Background(), contractLinkID, request)
	if err != nil {
		t.Fatalf("PullCalendarEvents: %v", err)
	}
	if result.Applied != 3 {
		t.Fatalf("result = %+v", result)
	}
	requireSameJSON(t, "c2_pull_request", core.body("pull"))
}

func TestCalendarContractC3ChangesResponseDecodesStrictly(t *testing.T) {
	_, client := newContractCore(t)
	result, err := client.GetCalendarChanges(context.Background(), contractLinkID, 100)
	if err != nil {
		t.Fatalf("GetCalendarChanges: %v", err)
	}
	if len(result.Changes) != 3 {
		t.Fatalf("changes = %+v", result.Changes)
	}
	create, update, remove := result.Changes[0], result.Changes[1], result.Changes[2]
	if create.Op != "create" || create.ExternalID != nil || create.Version != nil || create.End == nil {
		t.Fatalf("create = %+v", create)
	}
	if update.Op != "update" || update.ExternalID == nil || *update.ExternalID != "evt-timed" || update.End != nil {
		t.Fatalf("update = %+v", update)
	}
	if remove.Op != "delete" || remove.Start != "" {
		t.Fatalf("delete = %+v", remove)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal changes: %v", err)
	}
	requireSameJSON(t, "c3_changes_response", encoded)
}

func TestCalendarContractC4PushedRequestMatchesFixture(t *testing.T) {
	core, client := newContractCore(t)
	err := client.ReportCalendarPushed(context.Background(), contractLinkID, []CalendarPushResult{
		{ItemID: "11111111-1111-4111-8111-111111111111", ExternalID: "evt-new", Version: `"3181161784713000"`, Status: "ok"},
		{ItemID: "22222222-2222-4222-8222-222222222222", ExternalID: "evt-timed", Version: `"3181161784712000"`, Status: "conflict", Detail: "calendar provider rejected a stale version"},
		{ItemID: "33333333-3333-4333-8333-333333333333", ExternalID: "evt-old", Version: "ck-9", Status: "gone", Detail: "calendar event no longer exists upstream"},
		{ItemID: "44444444-4444-4444-8444-444444444444", Status: "failed", Detail: "google calendar API returned 403: Forbidden"},
	})
	if err != nil {
		t.Fatalf("ReportCalendarPushed: %v", err)
	}
	requireSameJSON(t, "c4_pushed_request", core.body("pushed"))
}

func TestCalendarContractC5CursorRequestMatchesFixture(t *testing.T) {
	core, client := newContractCore(t)
	err := client.SetCalendarCursor(context.Background(), contractLinkID, "CPDAlvWDx70CEPDAlvWDx70CGAU=", true,
		contractTime(t, "2026-08-31T00:00:00Z"), contractTime(t, "2027-10-01T00:00:00Z"))
	if err != nil {
		t.Fatalf("SetCalendarCursor: %v", err)
	}
	requireSameJSON(t, "c5_cursor_request", core.body("cursor"))
}

func TestCalendarContractC6LogRequestMatchesFixture(t *testing.T) {
	core, client := newContractCore(t)
	itemID := "11111111-1111-4111-8111-111111111111"
	externalID := "evt-new"
	err := client.LogCalendarEntries(context.Background(), contractLinkID, []CalendarLogEntry{
		{Direction: "pull", Action: "error", Detail: "google calendar API returned 500"},
		{Direction: "push", Action: "skipped", ItemID: &itemID, ExternalID: &externalID, Detail: "item start is not a date or timestamp"},
	})
	if err != nil {
		t.Fatalf("LogCalendarEntries: %v", err)
	}
	requireSameJSON(t, "c6_log_request", core.body("log"))
}
