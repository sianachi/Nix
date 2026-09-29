package calendarsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newMicrosoftFakeClient(t *testing.T, handler http.HandlerFunc) (*MicrosoftClient, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewMicrosoftClient(server.URL, 5*time.Second, nil)
	if err != nil {
		t.Fatalf("NewMicrosoftClient: %v", err)
	}
	return client, server
}

func TestMicrosoftClientPullFirstRoundUsesWindowThenFollowsNextLink(t *testing.T) {
	var serverURL string
	calls := 0
	client, server := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.Header.Get("Prefer"); got == "" {
			t.Errorf("missing Prefer header")
		}
		w.Header().Set("Content-Type", "application/json")
		switch calls {
		case 1:
			if r.URL.Query().Get("startDateTime") == "" || r.URL.Query().Get("endDateTime") == "" {
				t.Errorf("first round must carry the window, query=%q", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"@odata.nextLink": serverURL + "/v1.0/me/calendars/primary/calendarView/delta?$skip=50",
				"value": []map[string]any{
					{"id": "AAMk-1", "changeKey": "ck-1", "subject": "1:1", "isAllDay": false,
						"start":                 map[string]any{"dateTime": "2026-09-29T14:00:00.0000000", "timeZone": "UTC"},
						"end":                   map[string]any{"dateTime": "2026-09-29T14:30:00.0000000", "timeZone": "UTC"},
						"originalStartTimeZone": "Eastern Standard Time",
						"originalEndTimeZone":   "Eastern Standard Time",
						"lastModifiedDateTime":  "2026-09-28T00:00:00Z"},
				},
			})
		case 2:
			if r.URL.Query().Get("startDateTime") != "" {
				t.Errorf("continuation request must not resend the window")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"@odata.deltaLink": serverURL + "/v1.0/me/calendars/primary/calendarView/delta?$deltatoken=final",
				"value": []map[string]any{
					{"id": "AAMk-2", "@removed": map[string]any{"reason": "deleted"}},
				},
			})
		}
	})
	serverURL = server.URL

	ctx := context.Background()
	windowStart, windowEnd := time.Now(), time.Now().Add(24*time.Hour)
	first, err := client.Pull(ctx, "test-token", "primary", "", windowStart, windowEnd, "")
	if err != nil {
		t.Fatalf("Pull round 1: %v", err)
	}
	if !first.Next || first.PageToken == "" {
		t.Fatalf("first page = %+v, want Next with a PageToken", first)
	}
	if len(first.Events) != 1 {
		t.Fatalf("first page events = %+v", first.Events)
	}
	event := first.Events[0]
	if event.Start.AllDay || event.Start.Zone != "America/New_York" {
		t.Fatalf("event start = %+v, want a timed America/New_York bound converted from Eastern Standard Time", event.Start)
	}
	// The Graph dateTime (14:00 UTC per the outlook.timezone Prefer header) must be re-expressed
	// as the equivalent instant in the authored zone: 10:00 Eastern Daylight Time.
	if got := event.Start.Instant.Hour(); got != 10 {
		t.Fatalf("converted hour = %d, want 10 (14:00 UTC in America/New_York)", got)
	}

	second, err := client.Pull(ctx, "test-token", "primary", "", windowStart, windowEnd, first.PageToken)
	if err != nil {
		t.Fatalf("Pull round 1 continuation: %v", err)
	}
	if second.Next || second.Cursor == "" {
		t.Fatalf("final page = %+v, want the deltaLink cursor", second)
	}
	if len(second.Events) != 1 || second.Events[0].Status != "cancelled" || second.Events[0].ExternalID != "AAMk-2" {
		t.Fatalf("removed event = %+v, want a cancelled AAMk-2", second.Events)
	}
}

func TestMicrosoftClientPullAllDayConvertsExclusiveEndToInclusive(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"@odata.deltaLink": "https://unused/delta",
			"value": []map[string]any{
				{"id": "AAMk-3", "subject": "Offsite", "isAllDay": true,
					"start":                map[string]any{"dateTime": "2026-10-01T00:00:00.0000000", "timeZone": "UTC"},
					"end":                  map[string]any{"dateTime": "2026-10-04T00:00:00.0000000", "timeZone": "UTC"},
					"lastModifiedDateTime": "2026-09-28T00:00:00Z"},
			},
		})
	})
	page, err := client.Pull(context.Background(), "t", "primary", "", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(page.Events) != 1 {
		t.Fatalf("events = %+v", page.Events)
	}
	event := page.Events[0]
	if !event.Start.AllDay || event.Start.Date != "2026-10-01" {
		t.Fatalf("start = %+v, want all-day 2026-10-01", event.Start)
	}
	if !event.End.AllDay || event.End.Date != "2026-10-03" {
		t.Fatalf("end = %+v, want the inclusive 2026-10-03 (exclusive end 2026-10-04 minus one day)", event.End)
	}
}

func TestMicrosoftClientUpdateEventReportsConflictOn412(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if r.Header.Get("If-Match") != "stale-change-key" {
			t.Errorf("If-Match = %q", r.Header.Get("If-Match"))
		}
		w.WriteHeader(http.StatusPreconditionFailed)
	})
	_, err := client.UpdateEvent(context.Background(), "t", "primary", "AAMk-1", "stale-change-key", PushEvent{
		Title: "Renamed", Start: Bound{AllDay: true, Date: "2026-10-01"},
	})
	if err != ErrConflict {
		t.Fatalf("UpdateEvent err = %v, want ErrConflict", err)
	}
}

func TestMicrosoftClientDeleteEventTreats404AsSuccess(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if err := client.DeleteEvent(context.Background(), "t", "primary", "AAMk-1", "ck"); err != nil {
		t.Fatalf("DeleteEvent: %v, want nil for an already-gone event", err)
	}
}

func TestMicrosoftClientCreateEventAllDaySendsIsAllDay(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["isAllDay"] != true {
			t.Fatalf("isAllDay = %v, want true", body["isAllDay"])
		}
		end := body["end"].(map[string]any)
		if end["dateTime"] != "2026-09-30T00:00:00.0000000" {
			t.Fatalf("end.dateTime = %v, want the exclusive 2026-09-30 midnight", end["dateTime"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "AAMk-new", "changeKey": "ck-new"})
	})
	inclusiveEnd := Bound{AllDay: true, Date: "2026-09-29"}
	externalID, version, err := client.CreateEvent(context.Background(), "t", "primary", PushEvent{
		Title: "Day trip", Start: Bound{AllDay: true, Date: "2026-09-29"}, End: &inclusiveEnd,
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if externalID != "AAMk-new" || version != "ck-new" {
		t.Fatalf("CreateEvent = (%q, %q)", externalID, version)
	}
}
