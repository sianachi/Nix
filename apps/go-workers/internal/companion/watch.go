package companion

import (
	"context"
	"sync/atomic"
	"time"
)

// maxConcurrentWatchers bounds how many "watch" long-polls one account (one tenant+principal)
// may have open at once. Core's NixUnitOfWorkMiddleware keeps a Postgres connection and an open
// unit-of-work transaction pinned behind every watch it forwards for the whole wait, not
// PetWorkerClient.ExecuteWatchAsync (that is only the client-side call that starts the wait), so
// this is what bounds pinned connections per principal; it is checked in ServeHTTP, before a
// conversation is ever loaded, so a rejected watch costs nothing beyond the check itself.
const maxConcurrentWatchers = 4

// minWatchDwell bounds how soon awaitChange may return once it has a change to report: at
// least this long after the watch started, so a client streaming a reply through repeated
// watch calls cannot receive more than roughly 8 snapshots a second. after == 0 (the caller has
// no prior revision to compare against) always returns immediately; there is nothing to
// throttle on a first look.
const minWatchDwell = 120 * time.Millisecond

// tryAcquireWatcher claims one of the account's maxConcurrentWatchers watch slots, reporting
// whether it stayed within the cap. On failure it has already released the slot it claimed, so
// the caller never pairs a failed acquire with releaseWatcher.
func (a *account) tryAcquireWatcher() bool {
	if atomic.AddInt32(&a.watchers, 1) > maxConcurrentWatchers {
		atomic.AddInt32(&a.watchers, -1)
		return false
	}
	return true
}

// releaseWatcher releases a watch slot claimed by a successful tryAcquireWatcher.
func (a *account) releaseWatcher() {
	atomic.AddInt32(&a.watchers, -1)
}

// bumpLocked marks c as changed and wakes every watcher blocked on a.changed. Called with
// a.mu held: from saveLocked, so every persisted mutation bumps, and explicitly at every
// mutation that does not save (a delta, a final answer append, an error or reason set).
func (a *account) bumpLocked(c *conversation) {
	now := time.Now().UnixMilli()
	if now <= c.Revision {
		now = c.Revision + 1
	}
	c.Revision = now
	if a.changed != nil {
		close(a.changed)
	}
	a.changed = make(chan struct{})
}

// awaitChange blocks until key's conversation revision exceeds after, ctx is done, or
// timeout elapses, whichever comes first. It never touches the transport. When after != 0, it
// never returns because of a revision change sooner than minWatchDwell after it started (see
// minWatchDwell); after == 0 always returns as soon as a conversation exists.
func (a *account) awaitChange(ctx context.Context, key string, after int64, timeout time.Duration) {
	start := time.Now()
	deadline := start.Add(timeout)
	// Created once outside the loop: a watch that wakes, finds no usable change yet, and loops
	// again still waits out this same single dwell window rather than restarting it.
	var dwell <-chan time.Time
	if after != 0 {
		timer := time.NewTimer(minWatchDwell)
		defer timer.Stop()
		dwell = timer.C
	}
	for {
		a.mu.Lock()
		c := a.conversations[key]
		changed := c == nil || c.Revision > after
		if a.changed == nil {
			a.changed = make(chan struct{})
		}
		ch := a.changed
		a.mu.Unlock()
		if changed {
			if after == 0 {
				return
			}
			if remaining := minWatchDwell - time.Since(start); remaining > 0 {
				select {
				case <-dwell:
				case <-ctx.Done():
				}
			}
			return
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return
		}
		timer := time.NewTimer(remaining)
		select {
		case <-ch:
			timer.Stop()
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			return
		}
	}
}

// expireStaleThinking runs the 15-minute "thinking" timeout both the plain-read path and the
// watch path use: a conversation stuck mid-turn for too long is interrupted and marked as an
// error, so the client can retry. It manages its own non-blocking a.op claim: when a send or
// tool operation is genuinely using the transport, it skips the cleanup this time rather than
// block a caller (a read, or the return from a watch) that must never wait.
func (a *account) expireStaleThinking(ctx context.Context, key string, c *conversation) {
	a.mu.Lock()
	expired := c.State == "thinking" && time.Since(c.timing.started) > 15*time.Minute
	thread, turn := c.ThreadID, c.TurnID
	a.mu.Unlock()
	if !expired || !a.op.TryLock() {
		return
	}
	defer a.op.Unlock()
	a.cancelTools(key)
	_, _ = a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": thread, "turnId": turn})
	a.mu.Lock()
	c.State = "error"
	c.Reason = "The response timed out. You can send another message."
	a.bumpLocked(c)
	a.mu.Unlock()
}
