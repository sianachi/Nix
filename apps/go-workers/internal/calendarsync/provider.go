package calendarsync

import (
	"context"
	"errors"
	"time"
)

// ErrConflict is returned by Provider.UpdateEvent and Provider.DeleteEvent when the provider
// refused the write because the caller's version (Google If-Match etag, Graph If-Match
// changeKey) no longer matches the upstream event: someone else changed it first.
var ErrConflict = errors.New("calendar provider rejected a stale version")

// ErrGone is returned by Provider.UpdateEvent and Provider.DeleteEvent when the provider no
// longer has the event at all (it was deleted upstream by another client).
var ErrGone = errors.New("calendar event no longer exists upstream")

// ProviderEvent is one event pulled from Google or Microsoft, already normalized to the shape
// contract C2 needs: a status, a title, a start/end Bound pair, free text fields and the
// provider's own concurrency version.
type ProviderEvent struct {
	ExternalID string
	Version    string // Google etag or Graph changeKey
	Status     string // "confirmed" or "cancelled"
	Title      string
	Location   string
	Details    string
	Start      Bound
	End        *Bound
	ReadOnly   bool
	UpdatedAt  time.Time
}

// PushEvent is what the worker sends upstream when creating or updating a provider event from a
// Nix item change.
type PushEvent struct {
	Title    string
	Location string
	Details  string
	Start    Bound
	End      *Bound
}

// Page is one page of a provider pull. Next is true when PageToken must be used to fetch the
// next page of the same round; when Next is false, Cursor carries the syncToken/deltaLink to
// store once every page in the round has been applied (contract C5). FullResyncRequired is set
// when the provider rejected the supplied cursor (Google 410, an invalid Graph delta token) and
// the caller must restart the pull as a full resync.
type Page struct {
	Events             []ProviderEvent
	Next               bool
	PageToken          string
	Cursor             string
	FullResyncRequired bool
}

// Provider abstracts the two calendar back ends behind the pull/push shape the sync algorithm
// needs. Google and Microsoft each implement it against their own API.
type Provider interface {
	// Name identifies the provider for logging ("google" or "microsoft").
	Name() string
	// Pull fetches one page of changes. cursor is the stored syncToken/deltaLink, or "" for a
	// first/full round; pageToken continues a round already in progress ("" for its first page).
	Pull(ctx context.Context, accessToken, calendarID, cursor string, windowStart, windowEnd time.Time, pageToken string) (Page, error)
	// CreateEvent creates a new upstream event and returns its external id and version.
	CreateEvent(ctx context.Context, accessToken, calendarID string, event PushEvent) (externalID, version string, err error)
	// UpdateEvent patches an existing upstream event guarded by its last known version, and
	// returns the event's new version. It returns ErrConflict or ErrGone as described above.
	UpdateEvent(ctx context.Context, accessToken, calendarID, externalID, version string, event PushEvent) (newVersion string, err error)
	// DeleteEvent deletes an upstream event guarded by its last known version. Deleting an event
	// that is already gone is not an error. It returns ErrConflict when the version is stale.
	DeleteEvent(ctx context.Context, accessToken, calendarID, externalID, version string) error
}
