package workerapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestValidateCalendarEventRequiresStartOnlyForConfirmedEvents(t *testing.T) {
	now := time.Now()
	cancelled := CalendarEvent{ExternalID: "evt-1", Status: "cancelled", UpdatedAt: now}
	if err := validateCalendarEvent(cancelled); err != nil {
		t.Fatalf("cancelled event without start: %v, want accepted", err)
	}
	confirmed := CalendarEvent{ExternalID: "evt-2", Status: "confirmed", UpdatedAt: now}
	if err := validateCalendarEvent(confirmed); err == nil {
		t.Fatal("confirmed event without start was accepted")
	}
	confirmed.Start = "2026-10-01"
	if err := validateCalendarEvent(confirmed); err != nil {
		t.Fatalf("confirmed event with start: %v", err)
	}
}

func TestValidateCalendarEventAcceptsOnlyACanonicalItemStamp(t *testing.T) {
	event := CalendarEvent{ExternalID: "evt-1", Status: "confirmed", Start: "2026-10-01", UpdatedAt: time.Now()}
	for _, stamp := range []string{"not-a-uuid", "66666666-6666-4666-8666-66666666666G", "66666666-6666-4666-8666-666666666666 "} {
		value := stamp
		event.NixItemID = &value
		if err := validateCalendarEvent(event); err == nil {
			t.Fatalf("stamp %q was accepted", stamp)
		}
	}
	valid := "66666666-6666-4666-8666-666666666666"
	event.NixItemID = &valid
	if err := validateCalendarEvent(event); err != nil {
		t.Fatalf("canonical stamp: %v", err)
	}
}

func TestLogCalendarEntriesAcceptsOnlyTheWorkerActions(t *testing.T) {
	client := New("http://127.0.0.1:1", "secret", "worker", time.Second)
	for _, action := range []string{"created", "updated", "deleted", "anything"} {
		err := client.LogCalendarEntries(context.Background(), contractLinkID, []CalendarLogEntry{{Direction: "pull", Action: action, Detail: "x"}})
		if err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Fatalf("action %q: err = %v, want a validation error before any request", action, err)
		}
	}
}

// Core accepts at most 2 MiB per C2 body. A page of 100 events with long, escape-heavy details can
// exceed that, so the client must split the batch rather than send a body Core rejects forever.
func TestPullCalendarEventsSplitsBatchesAboveTheBodyLimit(t *testing.T) {
	var mu sync.Mutex
	var sizes []int
	var received int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request CalendarPullRequest
		if err := json.Unmarshal(body, &request); err != nil {
			t.Errorf("decode: %v", err)
		}
		mu.Lock()
		sizes = append(sizes, len(body))
		received += len(request.Events)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CalendarPullResult{Applied: len(request.Events), Conflicts: 1})
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", 5*time.Second)

	// Control characters escape to six bytes each, so 8000 of them is 48 KB per event.
	details := strings.Repeat("\x01", maxCalendarDetailsLength)
	events := make([]CalendarEvent, maxCalendarEventsPerBatch)
	for index := range events {
		events[index] = CalendarEvent{ExternalID: "evt", Status: "confirmed", Start: "2026-10-01", Details: details, UpdatedAt: time.Now()}
	}
	result, err := client.PullCalendarEvents(context.Background(), contractLinkID, CalendarPullRequest{Full: true, Events: events})
	if err != nil {
		t.Fatalf("PullCalendarEvents: %v", err)
	}
	if len(sizes) < 2 {
		t.Fatalf("requests = %d, want the batch split", len(sizes))
	}
	for _, size := range sizes {
		if size > MaxCalendarPullBodyBytes {
			t.Fatalf("request body = %d bytes, want at most %d", size, MaxCalendarPullBodyBytes)
		}
	}
	if received != len(events) || result.Applied != len(events) || result.Conflicts != len(sizes) {
		t.Fatalf("received=%d result=%+v requests=%d, want every event applied once and results summed", received, result, len(sizes))
	}
}

// C3 may return 100 changes whose details are each up to 8000 characters. Core's JSON encoder
// escapes non-ASCII text as \uXXXX, so a legal page reaches several MiB and must still decode.
func TestGetCalendarChangesAcceptsAFullPageOfEscapedDetails(t *testing.T) {
	details := strings.Repeat(`\u00e9`, maxCalendarDetailsLength)
	var page strings.Builder
	page.WriteString(`{"changes":[`)
	for index := 0; index < maxCalendarChangesLimit; index++ {
		if index > 0 {
			page.WriteString(",")
		}
		page.WriteString(`{"itemId":"11111111-1111-4111-8111-111111111111","externalId":null,"version":null,"op":"create","title":"t","start":"2026-10-01","end":null,"location":"","details":"` + details + `","updatedAt":"2026-09-30T10:00:00Z"}`)
	}
	page.WriteString(`]}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, page.String())
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", 5*time.Second)
	result, err := client.GetCalendarChanges(context.Background(), contractLinkID, maxCalendarChangesLimit)
	if err != nil {
		t.Fatalf("GetCalendarChanges (%d bytes): %v", page.Len(), err)
	}
	if len(result.Changes) != maxCalendarChangesLimit || len(result.Changes[0].Details) != 2*maxCalendarDetailsLength {
		t.Fatalf("decoded %d changes", len(result.Changes))
	}
}
