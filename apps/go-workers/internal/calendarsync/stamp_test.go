package calendarsync

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// Every event the worker creates carries the Nix item id it was created for, so a create whose C4
// report is lost is recognised on the next pull instead of being mirrored as a second item and
// pushed again (ADR-0052 Amendment 1, the item stamp).

const stampItemID = "0190f1e2-3c4d-7a5b-8c6d-7e8f9a0b1c2d"
const stampGoogleID = "0190f1e23c4d7a5b8c6d7e8f9a0b1c2d"

func TestGoogleClientCreateEventStampsTheItemID(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["id"] != stampGoogleID {
			t.Fatalf("id = %v, want the item id without dashes", body["id"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": stampGoogleID, "etag": `"e1"`})
	})
	externalID, version, err := client.CreateEvent(context.Background(), "t", "primary", PushEvent{
		Title: "Lunch", Start: Bound{AllDay: true, Date: "2026-10-03"}, NixItemID: stampItemID,
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if externalID != stampGoogleID || version != `"e1"` {
		t.Fatalf("CreateEvent = (%q, %q)", externalID, version)
	}
}

// A retried create (its first attempt landed, its report did not) meets Google's 409 for the
// client-supplied id. The event is then the one this item already created: it is restored if it
// was deleted meanwhile, brought to the pushed fields, and confirmed under that id.
func TestGoogleClientCreateEventTreatsADuplicateIDAsTheSameEvent(t *testing.T) {
	var methods []string
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": 409, "message": "The requested identifier already exists."}})
		case http.MethodPatch:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body["status"] != "confirmed" || body["summary"] != "Lunch" {
				t.Fatalf("patch body = %v, want the pushed fields with status confirmed", body)
			}
			if r.Header.Get("If-Match") != "" {
				t.Fatalf("If-Match = %q, want none: the event is this item's own", r.Header.Get("If-Match"))
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": stampGoogleID, "etag": `"e2"`})
		default:
			t.Fatalf("unexpected %s", r.Method)
		}
	})
	externalID, version, err := client.CreateEvent(context.Background(), "t", "primary", PushEvent{
		Title: "Lunch", Start: Bound{AllDay: true, Date: "2026-10-03"}, NixItemID: stampItemID,
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if externalID != stampGoogleID || version != `"e2"` {
		t.Fatalf("CreateEvent = (%q, %q)", externalID, version)
	}
	want := []string{"POST /calendar/v3/calendars/primary/events", "PATCH /calendar/v3/calendars/primary/events/" + stampGoogleID}
	if len(methods) != 2 || methods[0] != want[0] || methods[1] != want[1] {
		t.Fatalf("calls = %v, want %v", methods, want)
	}
}

func TestGoogleClientPullReadsTheItemStampFromTheEventID(t *testing.T) {
	client := newGoogleFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nextSyncToken": "next",
			"items": []map[string]any{
				{"id": stampGoogleID, "etag": `"e1"`, "status": "confirmed", "summary": "Lunch", "start": map[string]any{"date": "2026-10-03"}, "end": map[string]any{"date": "2026-10-04"}, "updated": "2026-09-30T12:00:00Z"},
				{"id": "abc123def456ghi789jkl0mn", "etag": `"e2"`, "status": "confirmed", "summary": "Theirs", "start": map[string]any{"date": "2026-10-03"}, "end": map[string]any{"date": "2026-10-04"}, "updated": "2026-09-30T12:00:00Z"},
				{"id": stampGoogleID + "_20261003", "etag": `"e3"`, "status": "confirmed", "summary": "Instance", "start": map[string]any{"date": "2026-10-03"}, "end": map[string]any{"date": "2026-10-04"}, "updated": "2026-09-30T12:00:00Z"},
			},
		})
	})
	page, err := client.Pull(context.Background(), "t", "primary", "", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(page.Events) != 3 || page.Events[0].NixItemID != stampItemID || page.Events[1].NixItemID != "" || page.Events[2].NixItemID != "" {
		t.Fatalf("events = %+v, want only the first stamped", page.Events)
	}
}

func TestMicrosoftClientCreateEventStampsTheTransactionAndAnExtendedProperty(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["transactionId"] != stampItemID {
			t.Fatalf("transactionId = %v, want the item id", body["transactionId"])
		}
		properties, _ := body["singleValueExtendedProperties"].([]any)
		if len(properties) != 1 {
			t.Fatalf("singleValueExtendedProperties = %v, want one", body["singleValueExtendedProperties"])
		}
		property := properties[0].(map[string]any)
		if property["id"] != graphItemPropertyID || property["value"] != stampItemID {
			t.Fatalf("extended property = %v", property)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "AAMk-new", "changeKey": "ck-new"})
	})
	if _, _, err := client.CreateEvent(context.Background(), "t", "primary", PushEvent{
		Title: "Lunch", Start: Bound{AllDay: true, Date: "2026-10-03"}, NixItemID: stampItemID,
	}); err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
}

func TestMicrosoftClientPullReadsTheItemStampFromTheTransactionID(t *testing.T) {
	client, _ := newMicrosoftFakeClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"@odata.deltaLink": "https://unused/delta",
			"value": []map[string]any{
				{"id": "AAMk-1", "changeKey": "ck1", "subject": "Lunch", "transactionId": stampItemID,
					"start":                map[string]any{"dateTime": "2026-10-03T12:00:00.0000000", "timeZone": "UTC"},
					"end":                  map[string]any{"dateTime": "2026-10-03T13:00:00.0000000", "timeZone": "UTC"},
					"lastModifiedDateTime": "2026-09-30T12:00:00Z"},
				{"id": "AAMk-2", "changeKey": "ck2", "subject": "Other app", "transactionId": "not-a-nix-item",
					"start":                map[string]any{"dateTime": "2026-10-03T12:00:00.0000000", "timeZone": "UTC"},
					"end":                  map[string]any{"dateTime": "2026-10-03T13:00:00.0000000", "timeZone": "UTC"},
					"lastModifiedDateTime": "2026-09-30T12:00:00Z"},
			},
		})
	})
	page, err := client.Pull(context.Background(), "t", "primary", "", time.Now(), time.Now().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(page.Events) != 2 || page.Events[0].NixItemID != stampItemID || page.Events[1].NixItemID != "" {
		t.Fatalf("events = %+v, want only the first stamped", page.Events)
	}
}

func TestHandlerStampsCreatesAndForwardsPulledStamps(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("two_way")
	core.changes = workerapi.CalendarChangesResult{Changes: []workerapi.CalendarChange{
		{ItemID: stampItemID, Op: "create", Title: "Lunch", Start: "2026-10-03", UpdatedAt: time.Now()},
	}}
	google := &fakeProvider{name: "google", createID: stampGoogleID, createVersion: "v1", pages: []Page{{Events: []ProviderEvent{
		{ExternalID: stampGoogleID, Version: "v1", Status: "confirmed", Title: "Lunch", Start: Bound{AllDay: true, Date: "2026-10-03"}, UpdatedAt: time.Now(), NixItemID: stampItemID},
		{ExternalID: "theirs", Version: "v1", Status: "confirmed", Title: "Theirs", Start: Bound{AllDay: true, Date: "2026-10-03"}, UpdatedAt: time.Now()},
	}, Cursor: "next"}}}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	if _, err := handler.Handle(context.Background(), job); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if len(google.created) != 1 || google.created[0].NixItemID != stampItemID {
		t.Fatalf("created = %+v, want the create stamped with its item id", google.created)
	}
	events := core.pullRequests[0].Events
	if len(events) != 2 || events[0].NixItemID == nil || *events[0].NixItemID != stampItemID || events[1].NixItemID != nil {
		t.Fatalf("pulled events = %+v, want only the stamped one to carry nixItemId", events)
	}
}
