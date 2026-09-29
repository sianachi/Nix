package calendarsync

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

// fakeProvider is a scripted Provider double so the sync algorithm can be exercised without a
// real Google or Microsoft client; the Google/Microsoft-specific behavior (paging, 410, RFC 9557
// conversion, all-day exclusivity) is already covered against real HTTP fakes in
// google_test.go/microsoft_test.go.
type fakeProvider struct {
	name    string
	pages   []Page
	pullErr error

	created []PushEvent
	updated []struct {
		externalID, version string
		event               PushEvent
	}
	deleted []struct{ externalID, version string }

	createID, createVersion string
	createErr               error
	updateVersion           string
	updateErr               error
	deleteErr               error
}

func (p *fakeProvider) Name() string { return p.name }

func (p *fakeProvider) Pull(ctx context.Context, accessToken, calendarID, cursor string, windowStart, windowEnd time.Time, pageToken string) (Page, error) {
	if p.pullErr != nil {
		return Page{}, p.pullErr
	}
	if len(p.pages) == 0 {
		return Page{}, nil
	}
	page := p.pages[0]
	p.pages = p.pages[1:]
	return page, nil
}

func (p *fakeProvider) CreateEvent(ctx context.Context, accessToken, calendarID string, event PushEvent) (string, string, error) {
	p.created = append(p.created, event)
	if p.createErr != nil {
		return "", "", p.createErr
	}
	return p.createID, p.createVersion, nil
}

func (p *fakeProvider) UpdateEvent(ctx context.Context, accessToken, calendarID, externalID, version string, event PushEvent) (string, error) {
	p.updated = append(p.updated, struct {
		externalID, version string
		event               PushEvent
	}{externalID, version, event})
	if p.updateErr != nil {
		return "", p.updateErr
	}
	return p.updateVersion, nil
}

func (p *fakeProvider) DeleteEvent(ctx context.Context, accessToken, calendarID, externalID, version string) error {
	p.deleted = append(p.deleted, struct{ externalID, version string }{externalID, version})
	return p.deleteErr
}

// fakeCore is an httptest.Server standing in for Core's /internal/worker-executions/calendar/...
// surface (contracts C1-C6), driving the real *workerapi.Client so the handler is exercised
// exactly as it runs in production.
type fakeCore struct {
	server *httptest.Server

	session          workerapi.CalendarSession
	sessionErrStatus int
	sessionErrCode   string

	pullRequests []workerapi.CalendarPullRequest
	pullResult   workerapi.CalendarPullResult

	changes workerapi.CalendarChangesResult

	pushedResults []workerapi.CalendarPushResult

	cursorRequests []struct {
		cursor string
		full   bool
	}

	logEntries []workerapi.CalendarLogEntry
}

func newFakeCore(t *testing.T) *fakeCore {
	t.Helper()
	core := &fakeCore{}
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/session", func(w http.ResponseWriter, r *http.Request) {
		if core.sessionErrStatus != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(core.sessionErrStatus)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": core.sessionErrCode})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(core.session)
	})
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/pull", func(w http.ResponseWriter, r *http.Request) {
		var request workerapi.CalendarPullRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode pull request: %v", err)
		}
		core.pullRequests = append(core.pullRequests, request)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(core.pullResult)
	})
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/changes", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(core.changes)
	})
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/pushed", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Results []workerapi.CalendarPushResult `json:"results"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode pushed request: %v", err)
		}
		core.pushedResults = request.Results
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/cursor", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Cursor string `json:"cursor"`
			Full   bool   `json:"full"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode cursor request: %v", err)
		}
		core.cursorRequests = append(core.cursorRequests, struct {
			cursor string
			full   bool
		}{request.Cursor, request.Full})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/internal/worker-executions/calendar/links/33333333-3333-3333-3333-333333333333/log", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Entries []workerapi.CalendarLogEntry `json:"entries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode log request: %v", err)
		}
		core.logEntries = append(core.logEntries, request.Entries...)
		w.WriteHeader(http.StatusNoContent)
	})
	core.server = httptest.NewServer(mux)
	t.Cleanup(core.server.Close)
	return core
}

func (core *fakeCore) client() *workerapi.Client {
	return workerapi.New(core.server.URL, "test-secret", "test-worker", 5*time.Second)
}

func baseSession(direction string) workerapi.CalendarSession {
	return workerapi.CalendarSession{
		Provider:             "google",
		ExternalCalendarID:   "primary",
		Direction:            direction,
		WindowStart:          time.Now().Add(-24 * time.Hour),
		WindowEnd:            time.Now().Add(24 * time.Hour),
		AccessToken:          "token",
		AccessTokenExpiresAt: time.Now().Add(time.Hour),
	}
}

func TestHandlerPullOnlyAppliesEventsAndStoresCursor(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("import_only")
	core.pullResult = workerapi.CalendarPullResult{Applied: 1, Conflicts: 0}
	google := &fakeProvider{name: "google", pages: []Page{
		{Events: []ProviderEvent{{
			ExternalID: "evt-1", Version: "v1", Status: "confirmed", Title: "Standup",
			Start: Bound{AllDay: true, Date: "2026-09-29"}, UpdatedAt: time.Now(),
		}}, Next: false, Cursor: "sync-1"},
	}}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	summary := result.(Result)
	if summary.Applied != 1 || summary.Pushed != 0 {
		t.Fatalf("Result = %+v, want Applied=1 Pushed=0 for an import_only link", summary)
	}
	if len(core.cursorRequests) != 1 || core.cursorRequests[0].cursor != "sync-1" {
		t.Fatalf("cursorRequests = %+v, want one request storing sync-1", core.cursorRequests)
	}
	if len(core.pushedResults) != 0 {
		t.Fatalf("import_only link pushed results = %+v, want none", core.pushedResults)
	}
}

func TestHandlerTwoWayPushesChangesAfterPull(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("two_way")
	core.pullResult = workerapi.CalendarPullResult{Applied: 0, Conflicts: 0}
	itemID := "11111111-1111-1111-1111-111111111111"
	core.changes = workerapi.CalendarChangesResult{Changes: []workerapi.CalendarChange{
		{ItemID: itemID, Op: "create", Title: "New event", Start: "2026-10-01", UpdatedAt: time.Now()},
	}}
	google := &fakeProvider{name: "google", pages: []Page{{Next: false, Cursor: "sync-2"}}, createID: "evt-created", createVersion: "v-created"}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	summary := result.(Result)
	if summary.Pushed != 1 {
		t.Fatalf("Result = %+v, want Pushed=1", summary)
	}
	if len(google.created) != 1 || google.created[0].Title != "New event" {
		t.Fatalf("google.created = %+v", google.created)
	}
	if len(core.pushedResults) != 1 || core.pushedResults[0].Status != "ok" || core.pushedResults[0].ExternalID != "evt-created" {
		t.Fatalf("pushedResults = %+v, want one ok result with ExternalID evt-created", core.pushedResults)
	}
}

func TestHandlerPushConflictReportsConflictStatus(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("two_way")
	core.pullResult = workerapi.CalendarPullResult{}
	itemID := "22222222-2222-2222-2222-222222222222"
	externalID := "evt-existing"
	version := "stale"
	core.changes = workerapi.CalendarChangesResult{Changes: []workerapi.CalendarChange{
		{ItemID: itemID, ExternalID: &externalID, Version: &version, Op: "update", Title: "Renamed", Start: "2026-10-01", UpdatedAt: time.Now()},
	}}
	google := &fakeProvider{name: "google", pages: []Page{{Next: false}}, updateErr: ErrConflict}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	if _, err := handler.Handle(context.Background(), job); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if len(core.pushedResults) != 1 || core.pushedResults[0].Status != "conflict" {
		t.Fatalf("pushedResults = %+v, want one conflict result", core.pushedResults)
	}
}

func TestHandlerFullResyncOn410RestartsWithFullTrue(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("import_only")
	stored := "expired-token"
	core.session.Cursor = &stored
	core.pullResult = workerapi.CalendarPullResult{Applied: 2}
	google := &fakeProvider{name: "google", pages: []Page{
		{FullResyncRequired: true},
		{Events: []ProviderEvent{{ExternalID: "evt-1", Status: "confirmed", Start: Bound{AllDay: true, Date: "2026-09-29"}, UpdatedAt: time.Now()}}, Next: false, Cursor: "fresh-token"},
	}}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	summary := result.(Result)
	if !summary.FullSync {
		t.Fatalf("Result = %+v, want FullSync=true after a 410", summary)
	}
	if len(core.pullRequests) != 1 || !core.pullRequests[0].Full {
		t.Fatalf("pullRequests = %+v, want exactly one request with Full=true", core.pullRequests)
	}
	if len(core.cursorRequests) != 1 || !core.cursorRequests[0].full || core.cursorRequests[0].cursor != "fresh-token" {
		t.Fatalf("cursorRequests = %+v, want one full=true request storing fresh-token", core.cursorRequests)
	}
}

func TestHandlerNeedsReauthIsNonRetryable(t *testing.T) {
	core := newFakeCore(t)
	core.sessionErrStatus = http.StatusConflict
	core.sessionErrCode = "calendar.needs_reauth"
	handler := NewHandler(core.client(), &fakeProvider{name: "google"}, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	_, err := handler.Handle(context.Background(), job)
	var typed *jobrunner.JobError
	if !errors.As(err, &typed) {
		t.Fatalf("err = %v, want a *jobrunner.JobError", err)
	}
	if typed.Code != "calendar_needs_reauth" || typed.Retryable {
		t.Fatalf("JobError = %+v, want code calendar_needs_reauth and non-retryable", typed)
	}
}

func TestHandlerImportOnlyNeverCallsChanges(t *testing.T) {
	core := newFakeCore(t)
	core.session = baseSession("import_only")
	core.pullResult = workerapi.CalendarPullResult{}
	google := &fakeProvider{name: "google", pages: []Page{{Next: false}}}
	handler := NewHandler(core.client(), google, &fakeProvider{name: "microsoft"}, nil)

	job := workerapi.Job{ID: "job-1", Kind: "calendar.sync", Payload: json.RawMessage(`{"linkId":"33333333-3333-3333-3333-333333333333","full":false}`)}
	result, err := handler.Handle(context.Background(), job)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	summary := result.(Result)
	if summary.Pushed != 0 {
		t.Fatalf("Result = %+v, want Pushed=0 for an import_only link", summary)
	}
	if len(core.pushedResults) != 0 {
		t.Fatalf("pushedResults = %+v, want none: import_only links never push", core.pushedResults)
	}
}
