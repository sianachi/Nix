package companion

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const toolVersion = 4

type Request struct {
	TenantID        string `json:"tenantId"`
	PrincipalID     string `json:"principalId"`
	WorkspaceID     string `json:"workspaceId"`
	PetID           string `json:"petId"`
	Operation       string `json:"operation"`
	RequestID       string `json:"requestId"`
	Text            string `json:"text"`
	Instructions    string `json:"instructions"`
	ItemID          string `json:"itemId"`
	ItemTitle       string `json:"itemTitle"`
	SharedText      string `json:"sharedText"`
	Model           string `json:"model"`
	Mode            string `json:"mode"`
	WorkspaceAccess bool   `json:"workspaceAccess"`
	ToolID          string `json:"toolId"`
	ToolResult      string `json:"toolResult"`
	ToolSuccess     bool   `json:"toolSuccess"`
	HistoryID       string `json:"historyId"`
	// After is the client's last known conversation revision. Only "watch" uses it: the
	// operation waits for a change past this revision instead of returning immediately.
	After int64 `json:"after"`
}

type Action struct {
	Kind   string `json:"kind"`
	ItemID string `json:"itemId"`
	Title  string `json:"title"`
}

type Message struct {
	ID      string   `json:"id"`
	Role    string   `json:"role"`
	Text    string   `json:"text"`
	Actions []Action `json:"actions"`
}

type Response struct {
	Provider        string         `json:"provider"`
	Status          string         `json:"status"`
	Reason          string         `json:"reason"`
	CanConnect      bool           `json:"canConnect"`
	VerificationURL string         `json:"verificationUrl"`
	UserCode        string         `json:"userCode"`
	State           string         `json:"state"`
	Messages        []Message      `json:"messages"`
	Models          []Model        `json:"models"`
	Tools           []ToolCall     `json:"tools"`
	History         []HistoryEntry `json:"history"`
	// Revision lets a watcher tell whether anything changed since it last looked.
	Revision int64 `json:"revision"`
}

type conversation struct {
	ToolVersion     int        `json:"toolVersion"`
	ThreadID        string     `json:"threadId"`
	TurnID          string     `json:"-"`
	RequestID       string     `json:"requestId"`
	State           string     `json:"-"`
	Reason          string     `json:"reason,omitempty"`
	Mode            string     `json:"mode"`
	Messages        []Message  `json:"messages"`
	Started         time.Time  `json:"-"`
	WorkspaceAccess bool       `json:"-"`
	Tools           []ToolCall `json:"tools"`
	// Revision is never persisted: every load (fresh or restored) gets a new one, monotonic
	// across worker restarts because it is seeded from the clock rather than a counter.
	Revision int64 `json:"-"`
}

type account struct {
	mu sync.Mutex
	// op serializes state transitions while notifications continue to use mu.
	op            sync.Mutex
	transport     Transport
	home          string
	loginID       string
	url           string
	code          string
	status        string
	reason        string
	last          time.Time
	conversations map[string]*conversation
	models        []Model
	// consultModels is the owner's ordered model preference for consult (Design mode)
	// threads, from NIX_COMPANION_CONSULT_MODELS. Empty means the provider default.
	consultModels []string
	// changed is closed and replaced every time bumpLocked runs, waking every watcher
	// blocked on it. Read under mu, then selected on after mu is released.
	changed chan struct{}
	// watchers counts concurrent "watch" operations for this account, capping them so a
	// pile of open long-polls cannot exhaust the worker.
	watchers int32
}

type Manager struct {
	mu       sync.Mutex
	root     string
	binary   string
	ctx      context.Context
	accounts map[string]*account
	launch   func(context.Context, string, string, func(string, json.RawMessage)) (Transport, error)
	// consultModels is handed to each account created by this manager; see account.consultModels.
	consultModels []string
}

func New(ctx context.Context, root, binary string, consultModels []string) (*Manager, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("companion data directory must be absolute")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	m := &Manager{root: root, binary: binary, ctx: ctx, accounts: map[string]*account{}, launch: launch, consultModels: consultModels}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				m.Close()
				return
			case <-ticker.C:
				m.reap()
			}
		}
	}()
	return m, nil
}

func (m *Manager) reap() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, a := range m.accounts {
		a.mu.Lock()
		idle := time.Since(a.last) > 20*time.Minute
		a.mu.Unlock()
		if idle && a.op.TryLock() {
			_ = a.transport.Close()
			delete(m.accounts, key)
			a.op.Unlock()
		}
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, a := range m.accounts {
		_ = a.transport.Close()
		delete(m.accounts, key)
	}
}

func (m *Manager) account(ctx context.Context, r Request) (*account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := r.TenantID + "-" + r.PrincipalID
	if a := m.accounts[key]; a != nil {
		if live, ok := a.transport.(interface{ Alive() bool }); ok && !live.Alive() {
			delete(m.accounts, key)
		} else {
			a.mu.Lock()
			a.last = time.Now()
			a.mu.Unlock()
			return a, nil
		}
	}
	if len(m.accounts) >= 4 {
		return nil, errors.New("companion capacity reached")
	}
	a := &account{home: filepath.Join(m.root, key), status: "disconnected", conversations: map[string]*conversation{}, last: time.Now(), consultModels: m.consultModels}
	transport, err := m.launch(m.ctx, m.binary, a.home, a.notify)
	if err != nil {
		return nil, err
	}
	a.transport = transport
	if peer, ok := transport.(toolTransport); ok {
		peer.SetRequestHandler(a.toolRequest)
	}
	if _, err = a.handle(ctx, Request{Operation: "status"}); err != nil {
		_ = transport.Close()
		return nil, err
	}
	m.accounts[key] = a
	return a, nil
}

// ServeHTTP is mounted behind the worker's existing constant-time service authentication.
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var request Request
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&request) != nil || decoder.Decode(&extra) != io.EOF || !validRequest(request) {
		http.Error(w, "Invalid companion request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	a, err := m.account(ctx, request)
	if err != nil {
		http.Error(w, "Companion runtime unavailable", http.StatusServiceUnavailable)
		return
	}
	// A watch or a plain read never claims a.op: they must never see "Companion is busy"
	// while a send or tool operation holds it. Everything else keeps the exclusive lock.
	if request.Operation != "read" && request.Operation != "watch" {
		if !a.op.TryLock() {
			http.Error(w, "Companion is busy", http.StatusConflict)
			return
		}
		defer a.op.Unlock()
	}
	a.mu.Lock()
	a.last = time.Now()
	a.mu.Unlock()
	response, err := a.handle(ctx, request)
	if err != nil {
		http.Error(w, "Companion request failed; reconnect or retry", http.StatusBadGateway)
		return
	}
	_ = json.NewEncoder(w).Encode(response)
}

func validRequest(r Request) bool {
	if !uuid.MatchString(r.TenantID) || !uuid.MatchString(r.PrincipalID) {
		return false
	}
	switch r.Operation {
	case "status", "connect", "disconnect", "models":
		return true
	case "read", "watch", "send", "interrupt", "reset", "tool_claim", "tool_result", "history", "read_history", "delete_history":
		return uuid.MatchString(r.WorkspaceID) && uuid.MatchString(r.PetID) && len(r.Text) <= 8000 && len(r.SharedText) <= 16000 && len(r.Instructions) <= 4000 && len(r.Model) <= 160 && len(r.ToolResult) <= 32000 && len(r.ToolID) <= 200 && (r.Mode == "" || r.Mode == "chat" || r.Mode == "consult") && (r.Operation != "send" || (uuid.MatchString(r.RequestID) && strings.TrimSpace(r.Text) != "")) && (!strings.HasPrefix(r.Operation, "tool_") || (uuid.MatchString(r.RequestID) && r.ToolID != ""))
	default:
		return false
	}
}

func (a *account) handle(ctx context.Context, r Request) (Response, error) {
	if r.Operation == "models" {
		if err := a.listModels(ctx); err != nil {
			return Response{}, err
		}
	} else if r.Operation == "connect" {
		a.mu.Lock()
		pending := a.loginID != ""
		a.mu.Unlock()
		if !pending {
			raw, err := a.transport.Call(ctx, "account/login/start", map[string]string{"type": "chatgptDeviceCode"})
			if err != nil {
				return Response{}, err
			}
			var login struct {
				LoginID         string `json:"loginId"`
				VerificationURL string `json:"verificationUrl"`
				UserCode        string `json:"userCode"`
			}
			if json.Unmarshal(raw, &login) != nil || login.VerificationURL != "https://auth.openai.com/codex/device" || len(login.UserCode) > 32 {
				return Response{}, errors.New("invalid device login")
			}
			a.mu.Lock()
			a.loginID = login.LoginID
			a.url = login.VerificationURL
			a.code = login.UserCode
			a.status = "connecting"
			a.reason = "Open the sign-in page and enter the code. Device-code login must be enabled in ChatGPT security settings."
			a.mu.Unlock()
		}
	} else if r.Operation == "disconnect" {
		a.mu.Lock()
		active := make([][2]string, 0)
		for _, c := range a.conversations {
			if c.TurnID != "" {
				active = append(active, [2]string{c.ThreadID, c.TurnID})
			}
		}
		a.mu.Unlock()
		for _, turn := range active {
			if _, err := a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": turn[0], "turnId": turn[1]}); err != nil {
				return Response{}, err
			}
		}
		a.mu.Lock()
		login := a.loginID
		a.mu.Unlock()
		if login != "" {
			if _, err := a.transport.Call(ctx, "account/login/cancel", map[string]string{"loginId": login}); err != nil {
				return Response{}, err
			}
		}
		if _, err := a.transport.Call(ctx, "account/logout", map[string]any{}); err != nil {
			return Response{}, err
		}
		a.mu.Lock()
		a.status = "disconnected"
		a.loginID = ""
		a.url = ""
		a.code = ""
		a.reason = "ChatGPT disconnected."
		a.mu.Unlock()
	} else if r.Operation == "status" {
		raw, err := a.transport.Call(ctx, "account/read", map[string]bool{"refreshToken": false})
		if err != nil {
			return Response{}, err
		}
		var status struct {
			Account *struct {
				Type string `json:"type"`
			} `json:"account"`
		}
		if json.Unmarshal(raw, &status) != nil {
			return Response{}, errors.New("invalid account status")
		}
		a.mu.Lock()
		if status.Account != nil && status.Account.Type == "chatgpt" {
			a.status = "connected"
			a.reason = "ChatGPT connected. Messages use your account's Codex allowance."
			a.loginID = ""
			a.url = ""
			a.code = ""
		} else if a.loginID == "" {
			a.status = "disconnected"
			a.reason = "Connect your ChatGPT account to talk with your companion."
		}
		a.mu.Unlock()
	} else {
		key := r.WorkspaceID + "-" + r.PetID
		if r.Mode == "consult" {
			key += "-consult"
		}
		if r.Operation == "history" || r.Operation == "read_history" || r.Operation == "delete_history" {
			return a.history(key, r)
		}
		if err := a.load(key); err != nil {
			return Response{}, err
		}
		a.mu.Lock()
		c := a.conversations[key]
		state := c.State
		a.mu.Unlock()
		if strings.HasPrefix(r.Operation, "tool_") {
			if err := a.resolveTool(key, r); err != nil {
				return Response{}, err
			}
		} else if r.Operation == "send" {
			a.mu.Lock()
			duplicate := c.RequestID == r.RequestID
			a.mu.Unlock()
			if state == "thinking" && !duplicate {
				return Response{}, errors.New("turn already running")
			}
			if !duplicate {
				if err := a.send(ctx, key, r); err != nil {
					return Response{}, err
				}
			}
		} else if r.Operation == "interrupt" {
			a.cancelTools(key)
			a.mu.Lock()
			thread, turn := c.ThreadID, c.TurnID
			a.mu.Unlock()
			if turn != "" {
				if _, err := a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": thread, "turnId": turn}); err != nil {
					return Response{}, err
				}
			}
		} else if r.Operation == "reset" {
			if state == "thinking" {
				return Response{}, errors.New("stop the running turn first")
			}
			a.mu.Lock()
			if err := a.archiveLocked(key); err != nil {
				a.mu.Unlock()
				return Response{}, err
			}
			a.conversations[key] = &conversation{Messages: []Message{}, State: "idle"}
			err := a.saveLocked(key)
			a.mu.Unlock()
			if err != nil {
				return Response{}, err
			}
		} else if r.Operation == "watch" {
			// Never touches the transport; only waits for bumpLocked to close a.changed,
			// the request context to end, or its own timeout, whichever comes first.
			if atomic.AddInt32(&a.watchers, 1) <= 16 {
				a.awaitChange(ctx, key, r.After, 20*time.Second)
			}
			atomic.AddInt32(&a.watchers, -1)
		} else if state == "thinking" {
			a.mu.Lock()
			expired := time.Since(c.Started) > 15*time.Minute
			thread, turn := c.ThreadID, c.TurnID
			a.mu.Unlock()
			if !expired {
				return a.snapshot(key), nil
			}
			// ServeHTTP no longer holds a.op for "read", so this 15-minute expiry cleanup
			// (the only place a plain read can reach) manages its own non-blocking claim:
			// when a send or tool operation is using the transport, skip it this time
			// rather than block a read that must never wait.
			if a.op.TryLock() {
				a.cancelTools(key)
				_, _ = a.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": thread, "turnId": turn})
				a.mu.Lock()
				c.State = "error"
				c.Reason = "The response timed out. You can send another message."
				a.bumpLocked(c)
				a.mu.Unlock()
				a.op.Unlock()
			}
		}
		return a.snapshot(key), nil
	}
	return a.snapshot(""), nil
}

func (a *account) snapshot(key string) Response {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := Response{Provider: "chatgpt", Status: a.status, CanConnect: a.status != "connected", Reason: a.reason, VerificationURL: a.url, UserCode: a.code, State: "idle", Messages: []Message{}}
	r.Models = append([]Model{}, a.models...)
	r.Tools = []ToolCall{}
	r.History = []HistoryEntry{}
	if c := a.conversations[key]; c != nil {
		r.State = c.State
		if c.State == "error" && c.Reason != "" {
			r.Reason = c.Reason
		}
		r.Messages = append([]Message{}, c.Messages...)
		r.Tools = append([]ToolCall{}, c.Tools...)
		r.Revision = c.Revision
	}
	return r
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
// timeout elapses, whichever comes first. It never touches the transport.
func (a *account) awaitChange(ctx context.Context, key string, after int64, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for {
		a.mu.Lock()
		c := a.conversations[key]
		if c == nil || c.Revision > after {
			a.mu.Unlock()
			return
		}
		if a.changed == nil {
			a.changed = make(chan struct{})
		}
		ch := a.changed
		a.mu.Unlock()
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

func (a *account) load(key string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conversations[key] != nil {
		return nil
	}
	if len(a.conversations) >= 128 {
		return errors.New("conversation capacity reached")
	}
	c := &conversation{State: "idle", Messages: []Message{}}
	f, err := os.Open(filepath.Join(a.home, key+".json"))
	if err == nil {
		defer f.Close()
		if json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(c) != nil {
			return errors.New("conversation could not be restored")
		}
		c.State = "idle"
		for i := range c.Tools {
			if c.Tools[i].Status == "pending" || c.Tools[i].Status == "claimed" {
				c.Tools[i].Status = "interrupted"
				c.Tools[i].Result = "Worker restarted. Check Nix before requesting this change again."
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// Never persisted (json:"-"): every load, fresh or restored, gets a revision seeded
	// from the clock so it stays monotonic across a worker restart.
	c.Revision = time.Now().UnixMilli()
	a.conversations[key] = c
	return nil
}

func (a *account) saveLocked(key string) error {
	// Bounded provider conversation cache; workspace state is still owned by Core.
	c := a.conversations[key]
	a.bumpLocked(c)
	// A streaming draft (id contains ":draft:") is never durable: encode a copy with
	// drafts removed rather than the live conversation.
	persisted := *c
	persisted.Messages = withoutDrafts(c.Messages)
	path := filepath.Join(a.home, key+".json")
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(&persisted)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func (a *account) send(ctx context.Context, key string, r Request) error {
	a.mu.Lock()
	c := a.conversations[key]
	thread := c.ThreadID
	if c.ToolVersion != toolVersion {
		thread = ""
	}
	a.mu.Unlock()
	base := baseSharedRules + modeRules(r.Mode) + " Nix capabilities: " + catalogFor(r.Mode)
	params := map[string]any{"cwd": filepath.Join(a.home, "empty"), "sandbox": "read-only", "approvalPolicy": "on-request", "baseInstructions": base, "developerInstructions": r.Instructions}
	if r.Mode == "consult" && r.Model == "" && len(a.consultModels) > 0 {
		// No explicit model: try the owner's ordered consult preference against what the
		// provider actually offers; an empty result leaves "model" unset, so the provider
		// default is used (decision 4, pet-structure-consult-plan.md section 1.4).
		if err := a.listModels(ctx); err != nil {
			return err
		}
		a.mu.Lock()
		for _, preferred := range a.consultModels {
			for _, model := range a.models {
				if model.ID == preferred {
					r.Model = preferred
					break
				}
			}
			if r.Model != "" {
				break
			}
		}
		a.mu.Unlock()
		if r.Model != "" {
			params["model"] = r.Model
		}
	} else if r.Model != "" {
		if err := a.listModels(ctx); err != nil {
			return err
		}
		a.mu.Lock()
		found := false
		for _, model := range a.models {
			if model.ID == r.Model {
				found = true
			}
		}
		a.mu.Unlock()
		if !found {
			return errors.New("model is unavailable")
		}
		params["model"] = r.Model
	}
	method := "thread/start"
	if thread == "" {
		params["dynamicTools"] = workspaceTools(r.Mode)
	}
	if thread != "" {
		method = "thread/resume"
		params["threadId"] = thread
	}
	raw, err := a.transport.Call(ctx, method, params)
	if err != nil {
		return err
	}
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &started) != nil || started.Thread.ID == "" {
		return errors.New("invalid thread response")
	}
	thread = started.Thread.ID
	prompt, _ := json.Marshal(map[string]any{"message": r.Text, "workspaceId": r.WorkspaceID, "currentItemId": r.ItemID, "currentItemTitle": r.ItemTitle, "sharedText": r.SharedText, "workspaceAccess": r.WorkspaceAccess})
	a.mu.Lock()
	// A stale, previously used conversation (not a first-ever one, which has no thread
	// and ToolVersion 0) that is only now catching up to the current tool version had
	// its thread dropped above; tell the user before replacing their state below.
	if c.ThreadID != "" && c.ToolVersion != 0 && c.ToolVersion != toolVersion {
		c.Messages = append(c.Messages, Message{ID: r.RequestID + ":tools", Role: "system", Text: "Your pet was updated and starts a fresh conversation.", Actions: []Action{}})
	}
	c.ThreadID = thread
	c.ToolVersion = toolVersion
	c.RequestID = r.RequestID
	c.Mode = r.Mode
	c.State = "thinking"
	c.Reason = ""
	c.WorkspaceAccess = r.WorkspaceAccess
	c.Tools = []ToolCall{}
	c.Started = time.Now()
	c.Messages = append(c.Messages, Message{ID: r.RequestID, Role: "user", Text: r.Text, Actions: []Action{}})
	c.Messages = trimMessages(c.Messages, 16)
	err = a.saveLocked(key)
	a.mu.Unlock()
	if err != nil {
		return err
	}
	raw, err = a.transport.Call(ctx, "turn/start", map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": string(prompt)}}})
	if err != nil {
		a.mu.Lock()
		c.State = "error"
		c.Reason = "The response could not start. Check the selected model and ChatGPT connection, then retry."
		a.bumpLocked(c)
		a.mu.Unlock()
		return err
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &turn) != nil {
		return errors.New("invalid turn response")
	}
	a.mu.Lock()
	c.TurnID = turn.Turn.ID
	a.mu.Unlock()
	return nil
}

// withoutDrafts returns messages with every streaming draft (id contains ":draft:")
// removed. Drafts are in-memory-only progress; only the final message is durable.
func withoutDrafts(messages []Message) []Message {
	clean := make([]Message, 0, len(messages))
	for _, m := range messages {
		if strings.Contains(m.ID, ":draft:") {
			continue
		}
		clean = append(clean, m)
	}
	return clean
}

// draftID names the one streaming draft message for an item within a turn: stable across
// repeated deltas for the same item, and distinct across items and turns.
func draftID(requestID, itemID string) string {
	digest := sha256.Sum256([]byte(itemID))
	return fmt.Sprintf("%s:draft:%x", requestID, digest[:16])
}

// trimMessages keeps at most limit non-draft messages, dropping the oldest first. A
// streaming draft (id contains ":draft:") is never counted against the limit or evicted
// to make room: it is provisional and never persisted, but still visible while it streams.
func trimMessages(messages []Message, limit int) []Message {
	real := 0
	for _, m := range messages {
		if !strings.Contains(m.ID, ":draft:") {
			real++
		}
	}
	if real <= limit {
		return messages
	}
	drop := real - limit
	kept := make([]Message, 0, len(messages))
	for _, m := range messages {
		if drop > 0 && !strings.Contains(m.ID, ":draft:") {
			drop--
			continue
		}
		kept = append(kept, m)
	}
	return kept
}

// truncateUTF8 caps s at limit bytes, cutting back to the nearest rune boundary instead of
// splitting one, so a capped delta or answer is always valid text.
func truncateUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func (a *account) notify(method string, raw json.RawMessage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if method == "account/login/completed" {
		var p struct {
			Success bool `json:"success"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return
		}
		a.loginID = ""
		a.url = ""
		a.code = ""
		if p.Success {
			a.status = "connected"
			a.reason = "ChatGPT connected."
		} else {
			a.status = "error"
			a.reason = "Sign-in did not complete. Try connecting again."
		}
		return
	}
	var p struct {
		ThreadID string `json:"threadId"`
		ItemID   string `json:"itemId"`
		Delta    string `json:"delta"`
		Item     struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Text  string `json:"text"`
			Phase string `json:"phase"`
		} `json:"item"`
		Turn struct {
			Status string `json:"status"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	for key, c := range a.conversations {
		if c.ThreadID != p.ThreadID || p.ThreadID == "" {
			continue
		}
		if method == "item/agentMessage/delta" {
			if c.State != "thinking" || p.ItemID == "" || len(p.ItemID) > 200 || p.Delta == "" {
				continue
			}
			id := draftID(c.RequestID, p.ItemID)
			index := -1
			for i := range c.Messages {
				if c.Messages[i].ID == id {
					index = i
					break
				}
			}
			if index < 0 {
				c.Messages = append(c.Messages, Message{ID: id, Role: "assistant", Text: truncateUTF8(p.Delta, 32000), Actions: []Action{}})
				a.bumpLocked(c)
			} else if remaining := 32000 - len(c.Messages[index].Text); remaining > 0 {
				c.Messages[index].Text += truncateUTF8(p.Delta, remaining)
				a.bumpLocked(c)
			}
		}
		if method == "item/completed" && p.Item.Type == "agentMessage" && len(p.Item.ID) <= 200 {
			// The draft is only ever provisional; the commentary or final message below
			// replaces it once the item is done.
			id := draftID(c.RequestID, p.Item.ID)
			for i := range c.Messages {
				if c.Messages[i].ID == id {
					c.Messages = append(c.Messages[:i], c.Messages[i+1:]...)
					break
				}
			}
		}
		if method == "item/completed" && p.Item.Type == "agentMessage" && p.Item.Phase == "commentary" {
			text := strings.TrimSpace(p.Item.Text)
			var envelope struct {
				Answer string `json:"answer"`
			}
			if json.Unmarshal([]byte(text), &envelope) == nil && strings.TrimSpace(envelope.Answer) != "" {
				text = envelope.Answer
			}
			if c.State != "thinking" || text == "" || len(text) > 8000 || len(p.Item.ID) > 200 {
				continue
			}
			digest := sha256.Sum256([]byte(p.Item.ID))
			id := fmt.Sprintf("%s:commentary:%x", c.RequestID, digest[:16])
			seen := false
			if len(c.Messages) > 0 {
				last := c.Messages[len(c.Messages)-1]
				seen = last.Role == "assistant" && last.Text == text
			}
			for _, message := range c.Messages {
				if message.ID == id {
					seen = true
					break
				}
			}
			if !seen {
				c.Messages = append(c.Messages, Message{ID: id, Role: "assistant", Text: text, Actions: []Action{}})
				c.Messages = trimMessages(c.Messages, 40)
				_ = a.saveLocked(key)
			}
		}
		if method == "item/completed" && p.Item.Type == "agentMessage" && p.Item.Phase != "commentary" {
			// The final answer is plain text. A thread started before this change may still
			// send the legacy {"answer": string} envelope; unwrap it so old threads keep
			// working. Anything else, JSON or not, is used exactly as written.
			text := p.Item.Text
			var envelope struct {
				Answer string `json:"answer"`
			}
			if json.Unmarshal([]byte(text), &envelope) == nil && strings.TrimSpace(envelope.Answer) != "" {
				text = envelope.Answer
			}
			c.Messages = append(c.Messages, Message{ID: c.RequestID + ":assistant", Role: "assistant", Text: truncateUTF8(text, 32000), Actions: []Action{}})
			a.bumpLocked(c)
		}
		if method == "turn/completed" {
			a.cancelToolsLocked(key)
			c.Messages = withoutDrafts(c.Messages)
			c.TurnID = ""
			if p.Turn.Status == "completed" && c.State != "error" {
				c.State = "success"
			} else if p.Turn.Status == "interrupted" {
				c.State = "idle"
			} else {
				c.State = "error"
				if c.Reason == "" {
					c.Reason = "ChatGPT could not finish the response. Check account access and usage, then retry."
				}
			}
			if err := a.saveLocked(key); err != nil {
				c.State = "error"
				c.Reason = "Conversation could not be saved."
				a.bumpLocked(c)
			}
		}
	}
}
