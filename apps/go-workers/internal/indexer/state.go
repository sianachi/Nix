package indexer

import (
	"sync"
	"time"
)

type Outcome struct {
	Applied           bool
	Deleted           bool
	Stale             bool
	UsedLegacyPayload bool
	FallbackDropped   bool
}

type Health struct {
	Initialized      bool       `json:"initialized"`
	Consuming        bool       `json:"consuming"`
	Received         uint64     `json:"received"`
	Acknowledged     uint64     `json:"acknowledged"`
	Applied          uint64     `json:"applied"`
	Deleted          uint64     `json:"deleted"`
	Stale            uint64     `json:"stale"`
	Requeued         uint64     `json:"requeued"`
	Rejected         uint64     `json:"rejected"`
	LegacyFallbacks  uint64     `json:"legacyFallbacks"`
	FallbackDrops    uint64     `json:"fallbackDrops"`
	LastReceivedAt   *time.Time `json:"lastReceivedAt,omitempty"`
	LastSuccessfulAt *time.Time `json:"lastSuccessfulAt,omitempty"`
	LastFailureAt    *time.Time `json:"lastFailureAt,omitempty"`
	LastFailure      string     `json:"lastFailure,omitempty"`
}

type State struct {
	mu     sync.RWMutex
	health Health
}

func NewState() *State { return &State{} }

func (state *State) Ready() bool {
	state.mu.RLock()
	defer state.mu.RUnlock()
	return state.health.Initialized && state.health.Consuming
}

func (state *State) Snapshot() Health {
	state.mu.RLock()
	defer state.mu.RUnlock()
	return state.health
}

func (state *State) recordInitialized() {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Initialized = true
	state.health.LastFailure = ""
}

func (state *State) recordInitializationFailure(err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Initialized = false
	state.health.Consuming = false
	state.failure(err)
}

func (state *State) recordConsumerStarted() {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Consuming = true
}

func (state *State) recordConsumerStopped(err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Consuming = false
	if err != nil {
		state.failure(err)
	}
}

func (state *State) recordReceived() {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Received++
	now := time.Now().UTC()
	state.health.LastReceivedAt = &now
}

func (state *State) recordAcknowledged(outcome Outcome) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Acknowledged++
	if outcome.Applied {
		state.health.Applied++
	}
	if outcome.Deleted {
		state.health.Deleted++
	}
	if outcome.Stale {
		state.health.Stale++
	}
	if outcome.UsedLegacyPayload {
		state.health.LegacyFallbacks++
	}
	if outcome.FallbackDropped {
		state.health.FallbackDrops++
	}
	now := time.Now().UTC()
	state.health.LastSuccessfulAt = &now
	state.health.LastFailure = ""
}

func (state *State) recordRequeued(err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Requeued++
	state.failure(err)
}

func (state *State) recordRejected(err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.health.Rejected++
	state.failure(err)
}

func (state *State) failure(err error) {
	now := time.Now().UTC()
	state.health.LastFailureAt = &now
	state.health.LastFailure = err.Error()
	if len(state.health.LastFailure) > 512 {
		state.health.LastFailure = state.health.LastFailure[:512]
	}
}
