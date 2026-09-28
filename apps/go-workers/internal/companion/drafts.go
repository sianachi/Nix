package companion

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"unicode/utf8"
)

// maxTotalDraftBytes bounds the combined length of every streaming draft message in one
// conversation (there is normally one, but a turn can produce more than one agent-message item).
// Each individual draft is already capped at 32000 bytes; this second, whole-conversation cap
// keeps a pathological turn that streams many large drafts from growing memory unboundedly before
// turn/completed clears them.
const maxTotalDraftBytes = 64000

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

// draftBytes is the combined length of every streaming draft in messages.
func draftBytes(messages []Message) int {
	total := 0
	for _, m := range messages {
		if strings.Contains(m.ID, ":draft:") {
			total += len(m.Text)
		}
	}
	return total
}

// applyDeltaLocked applies one item/agentMessage/delta notification to c: it appends to or
// starts the one streaming draft for itemID, bounded by maxTotalDraftBytes across the whole
// conversation and 32000 bytes per draft. Called with a.mu held, from notify. A delta for a
// conversation not currently "thinking", an empty itemID, an oversize itemID or an empty delta
// is silently ignored, matching how notify has always dropped a malformed or out-of-turn event.
func (a *account) applyDeltaLocked(c *conversation, itemID, delta string) {
	if c.State != "thinking" || itemID == "" || len(itemID) > 200 || delta == "" {
		return
	}
	id := draftID(c.RequestID, itemID)
	index := -1
	for i := range c.Messages {
		if c.Messages[i].ID == id {
			index = i
			break
		}
	}
	total := draftBytes(c.Messages)
	if total >= maxTotalDraftBytes {
		return
	}
	if index < 0 {
		c.Messages = append(c.Messages, Message{ID: id, Role: "assistant", Text: truncateUTF8(delta, min(32000, maxTotalDraftBytes-total)), Actions: []Action{}})
		a.bumpLocked(c)
	} else if remaining := min(32000-len(c.Messages[index].Text), maxTotalDraftBytes-total); remaining > 0 {
		c.Messages[index].Text += truncateUTF8(delta, remaining)
		a.bumpLocked(c)
	}
}
