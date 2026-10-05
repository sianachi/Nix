package calendarsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newGoogleFakeClient(t *testing.T, handler http.HandlerFunc) *GoogleClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewGoogleClient(server.URL, 5*time.Second, nil)
	if err != nil {
		t.Fatalf("NewGoogleClient: %v", err)
	}
	return client
}

func TestGoogleClientPullPagesUntilNextSyncToken(t *testing.T) {
	calls := 0
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing bearer token, got %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch calls {
		case 1:
			if r.URL.Query().Get("pageToken") != "" {
				t.Errorf("first page should not carry a pageToken")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nextPageToken": "page-2",
				"items": []map[string]any{
					{"id": "evt-1", "etag": `"e1"`, "status": "confirmed", "summary": "Standup",
						"start":   map[string]any{"dateTime": "2026-09-29T10:00:00-04:00", "timeZone": "America/New_York"},
						"end":     map[string]any{"dateTime": "2026-09-29T10:15:00-04:00", "timeZone": "America/New_York"},
						"updated": "2026-09-28T00:00:00Z"},
				},
			})
		case 2:
			if r.URL.Query().Get("pageToken") != "page-2" {
				t.Errorf("second page should carry pageToken=page-2, got %q", r.URL.Query().Get("pageToken"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nextSyncToken": "sync-token-final",
				"items": []map[string]any{
					{"id": "evt-2", "etag": `"e2"`, "status": "confirmed", "summary": "Trip",
						"start":   map[string]any{"date": "2026-10-01"},
						"end":     map[string]any{"date": "2026-10-03"},
						"updated": "2026-09-28T00:00:00Z"},
				},
			})
		}
	})
	ctx := context.Background()
	windowStart, windowEnd := time.Now(), time.Now().Add(24*time.Hour)

	first, err := client.Pull(ctx, "test-token", "primary", "", windowStart, windowEnd, "")
	if err != nil {
		t.Fatalf("Pull page 1: %v", err)
	}
	if !first.Next || first.PageToken != "page-2" {
		t.Fatalf("page 1 = %+v, want Next with PageToken page-2", first)
	}
	if len(first.Events) != 1 || first.Events[0].ExternalID != "evt-1" {
		t.Fatalf("page 1 events = %+v", first.Events)
	}
	if first.Events[0].Start.AllDay || first.Events[0].Start.Zone != "America/New_York" {
		t.Fatalf("timed event start = %+v, want an America/New_York timed bound", first.Events[0].Start)
	}

	second, err := client.Pull(ctx, "test-token", "primary", "", windowStart, windowEnd, "page-2")
	if err != nil {
		t.Fatalf("Pull page 2: %v", err)
	}
	if second.Next || second.Cursor != "sync-token-final" {
		t.Fatalf("page 2 = %+v, want the final page carrying the sync token", second)
	}
	if len(second.Events) != 1 || !second.Events[0].End.AllDay || second.Events[0].End.Date != "2026-10-02" {
		t.Fatalf("all-day event = %+v, want an inclusive end of 2026-10-02 (exclusive end 2026-10-03 minus one day)", second.Events[0])
	}
}

func TestGoogleClientPullSyncTokenExcludesTimeWindow(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("timeMin") != "" || r.URL.Query().Get("timeMax") != "" {
			t.Errorf("a syncToken request must not also carry timeMin/timeMax, got %q", r.URL.RawQuery)
		}
		if r.URL.Query().Get("syncToken") != "stored-token" {
			t.Errorf("syncToken = %q, want stored-token", r.URL.Query().Get("syncToken"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"nextSyncToken": "stored-token"})
	})
	_, err := client.Pull(context.Background(), "t", "primary", "stored-token", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
}

func TestGoogleClientPull410RequestsFullResync(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte(`{"error":{"code":410,"message":"Sync token is no longer valid"}}`))
	})
	page, err := client.Pull(context.Background(), "t", "primary", "stale-token", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if !page.FullResyncRequired {
		t.Fatalf("page = %+v, want FullResyncRequired", page)
	}
}

func TestGoogleClientUpdateEventReportsConflictOn412(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if r.Header.Get("If-Match") != `"stale-etag"` {
			t.Errorf("If-Match = %q", r.Header.Get("If-Match"))
		}
		w.WriteHeader(http.StatusPreconditionFailed)
	})
	_, err := client.UpdateEvent(context.Background(), "t", "primary", "evt-1", `"stale-etag"`, PushEvent{
		Title: "Renamed", Start: Bound{AllDay: true, Date: "2026-10-01"},
	})
	if err != ErrConflict {
		t.Fatalf("UpdateEvent err = %v, want ErrConflict", err)
	}
}

func TestGoogleClientUpdateEventReportsGoneOn404(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	_, err := client.UpdateEvent(context.Background(), "t", "primary", "evt-1", "", PushEvent{
		Title: "Renamed", Start: Bound{AllDay: true, Date: "2026-10-01"},
	})
	if err != ErrGone {
		t.Fatalf("UpdateEvent err = %v, want ErrGone", err)
	}
}

func TestGoogleClientCreateEventSendsAllDayBodyExclusiveEnd(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		end := body["end"].(map[string]any)
		if end["date"] != "2026-09-30" {
			t.Fatalf("end.date = %v, want the exclusive 2026-09-30 for an inclusive 2026-09-29 end", end["date"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "evt-new", "etag": `"e-new"`})
	})
	inclusiveEnd := Bound{AllDay: true, Date: "2026-09-29"}
	externalID, version, err := client.CreateEvent(context.Background(), "t", "primary", PushEvent{
		Title: "Day trip", Start: Bound{AllDay: true, Date: "2026-09-29"}, End: &inclusiveEnd,
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if externalID != "evt-new" || version != `"e-new"` {
		t.Fatalf("CreateEvent = (%q, %q)", externalID, version)
	}
}

func TestGoogleClientRejectsUnconfiguredOrigin(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("the fake should never be reached")
	})
	// Point the transport at a different absolute URL to prove the origin allowlist is enforced.
	_, err := client.transport.do(context.Background(), http.MethodGet, "https://evil.example/attack", nil, nil)
	if err == nil {
		t.Fatal("expected the transport to reject a URL outside its configured origin")
	}
}

// An incremental (syncToken) round reports a deleted event as status=cancelled with no start or
// end. It must convert to a cancelled event instead of failing the whole page, which would retry
// the pull forever.
func TestGoogleClientPullCancelledIncrementalEventHasNoBounds(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("syncToken") != "stored" {
			t.Errorf("incremental round must carry the syncToken, query=%q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nextSyncToken": "next",
			"items": []map[string]any{
				{"id": "evt-gone", "etag": `"e9"`, "status": "cancelled"},
			},
		})
	})
	page, err := client.Pull(context.Background(), "t", "primary", "stored", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v, want the cancelled event accepted", err)
	}
	if len(page.Events) != 1 || page.Events[0].Status != "cancelled" || page.Events[0].ExternalID != "evt-gone" {
		t.Fatalf("events = %+v, want one cancelled evt-gone", page.Events)
	}
	if page.Events[0].UpdatedAt.IsZero() {
		t.Fatal("cancelled event UpdatedAt is zero; Core requires updatedAt")
	}
	wire := toWireEvent(page.Events[0])
	if wire.Start != "" || wire.End != nil {
		t.Fatalf("wire start/end = %q/%v, want empty for a cancelled event", wire.Start, wire.End)
	}
}
