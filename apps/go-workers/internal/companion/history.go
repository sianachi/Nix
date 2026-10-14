package companion

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

type HistoryEntry struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt string `json:"createdAt"`
}
type archivedConversation struct {
	HistoryEntry
	Messages []Message  `json:"messages"`
	Tools    []ToolCall `json:"tools"`
	// LockedRead carries the conversation's protected-read hold into the archive and back out on
	// resume. A pointer so an archive from before this field reads as absent, not as false.
	LockedRead *bool `json:"lockedRead,omitempty"`
}

// defaultTitle names a conversation after its first user message: whitespace collapsed, cut to
// 120 runes. The first message of a trimmed conversation need not be a user message.
func defaultTitle(messages []Message) string {
	for _, m := range messages {
		if m.Role == "user" {
			title := []rune(strings.Join(strings.Fields(m.Text), " "))
			if len(title) > 120 {
				title = title[:120]
			}
			return string(title)
		}
	}
	return ""
}

// validHistoryOp checks what rename and resume_history carry beyond a plain request: a title of
// 1 to 120 UTF-16 units once trimmed with no control characters, and the archive each names.
func validHistoryOp(r Request) bool {
	switch r.Operation {
	case "rename":
		title := strings.TrimSpace(r.Text)
		return title != "" && utf16Len(title) <= 120 && !strings.ContainsFunc(title, unicode.IsControl) && (r.HistoryID == "" || uuid.MatchString(r.HistoryID))
	case "resume_history":
		return uuid.MatchString(r.HistoryID)
	}
	return true
}

func (a *account) archiveLocked(key string) error {
	c := a.conversations[key]
	if len(c.Messages) == 0 {
		return nil
	}
	dir := filepath.Join(a.home, key+"-history")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) >= 32 {
		return errors.New("conversation history is full; export and remove an archived conversation first")
	}
	return writeArchive(dir, c)
}

// writeArchive stores c as one new history entry in dir.
func writeArchive(dir string, c *conversation) error {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return err
	}
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	id := fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
	title := c.Title
	if title == "" {
		title = defaultTitle(c.Messages)
	}
	locked := c.LockedRead
	return writeArchiveFile(dir, archivedConversation{HistoryEntry: HistoryEntry{id, title, time.Now().UTC().Format(time.RFC3339)}, Messages: c.Messages, Tools: c.Tools, LockedRead: &locked})
}

// writeArchiveFile writes value to dir/<its id>.json through a synced temp file and a rename, so
// a crash leaves the old entry or the new one, never half of either.
func writeArchiveFile(dir string, value archivedConversation) error {
	path := filepath.Join(dir, value.ID+".json")
	f, err := os.CreateTemp(dir, ".archive-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	err = json.NewEncoder(f).Encode(value)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

// foldDesign moves what the retired Design conversation left on disk for key (its live
// conversation and its archived threads, kept under key+"-consult") into key's own history,
// where it stays readable but takes no new messages. It is a no-op once nothing is left.
// Moved entries are not held to the 32-entry cap; nothing is dropped. Fixed: history now lists
// the newest 32 rather than an arbitrary 32, and archiveLocked refuses new entries until deletes
// bring the count back under the cap, so the overflow drains through the user's own deletes.
func (a *account) foldDesign(key string) error {
	old := key + "-consult"
	livePath := filepath.Join(a.home, old+".json")
	oldHistory := filepath.Join(a.home, old+"-history")
	exists := func(path string) bool {
		_, err := os.Stat(path)
		return !os.IsNotExist(err)
	}
	if !exists(livePath) && !exists(oldHistory) {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	// Checked again under the lock: a concurrent request may have folded these already.
	_, liveErr := os.Stat(livePath)
	_, historyErr := os.Stat(oldHistory)
	if os.IsNotExist(liveErr) && os.IsNotExist(historyErr) {
		return nil
	}
	target := filepath.Join(a.home, key+"-history")
	if err := os.MkdirAll(target, 0700); err != nil {
		return err
	}
	if liveErr == nil {
		f, err := os.Open(livePath)
		if err != nil {
			return err
		}
		var c conversation
		err = json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&c)
		_ = f.Close()
		if err != nil {
			return errors.New("design conversation could not be restored")
		}
		if len(c.Messages) > 0 {
			if err := writeArchive(target, &c); err != nil {
				return err
			}
		}
		if err := os.Remove(livePath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if historyErr == nil {
		entries, err := os.ReadDir(oldHistory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			id := strings.TrimSuffix(entry.Name(), ".json")
			if entry.IsDir() || !uuid.MatchString(id) {
				continue
			}
			if err := os.Rename(filepath.Join(oldHistory, entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		if err := os.RemoveAll(oldHistory); err != nil {
			return err
		}
	}
	a.removeTraceLocked(old)
	return nil
}

// readArchive loads one archive, bounded like every conversation file.
func readArchive(path string) (archivedConversation, error) {
	var value archivedConversation
	f, err := os.Open(path)
	if err != nil {
		return value, err
	}
	defer f.Close()
	if json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&value) != nil {
		return value, errors.New("history could not be loaded")
	}
	return value, nil
}

// resume swaps the archive r.HistoryID in as key's live conversation. The live one (when it has
// messages) is archived in its place, so the archive count never changes and the 32-entry cap
// cannot refuse a resume. The archive has no provider thread and no approval cards; the next
// send starts a fresh thread seeded with the visible messages (send). A legacy archive without
// a recorded hold resumes held, since its transcript may quote protected content.
func (a *account) resume(key string, r Request) error {
	dir := filepath.Join(a.home, key+"-history")
	path := filepath.Join(dir, r.HistoryID+".json")
	a.mu.Lock()
	defer a.mu.Unlock()
	old := a.conversations[key]
	if old.State == "thinking" {
		return errors.New("stop the running turn first")
	}
	value, err := readArchive(path)
	if err != nil {
		return err
	}
	if len(old.Messages) > 0 {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err := writeArchive(dir, old); err != nil {
			return err
		}
	}
	a.conversations[key] = &conversation{Messages: value.Messages, Tools: []ToolCall{}, State: "idle", Title: value.Title, RootItemID: r.RootItemID, LockedRead: value.LockedRead == nil || *value.LockedRead, Revision: old.Revision}
	if err := a.saveLocked(key); err != nil {
		return err
	}
	// Removed only after the live save: a crash between the two leaves a duplicate, not a loss.
	if err := os.Remove(path); err != nil {
		return err
	}
	a.removeTraceLocked(key)
	return nil
}

// renameLive sets the live conversation's title.
func (a *account) renameLive(key string, r Request) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversations[key]
	if c.State == "thinking" {
		return errors.New("stop the running turn first")
	}
	c.Title = strings.TrimSpace(r.Text)
	return a.saveLocked(key)
}

func (a *account) history(key string, r Request) (Response, error) {
	dir := filepath.Join(a.home, key+"-history")
	result := a.snapshot("")
	if r.Operation == "rename" {
		if !uuid.MatchString(r.HistoryID) {
			return Response{}, errors.New("invalid history identity")
		}
		value, err := readArchive(filepath.Join(dir, r.HistoryID+".json"))
		if err != nil {
			return Response{}, err
		}
		value.Title = strings.TrimSpace(r.Text)
		if err := writeArchiveFile(dir, value); err != nil {
			return Response{}, err
		}
	}
	if r.Operation == "read_history" || r.Operation == "delete_history" {
		if !uuid.MatchString(r.HistoryID) {
			return Response{}, errors.New("invalid history identity")
		}
		path := filepath.Join(dir, r.HistoryID+".json")
		if r.Operation == "delete_history" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return Response{}, err
			}
			// A trace (diagnostics.go) holds this conversation's full content too; deleting
			// history must not leave that copy behind.
			a.mu.Lock()
			a.removeTraceLocked(key)
			a.mu.Unlock()
		} else {
			value, err := readArchive(path)
			if err != nil {
				return Response{}, err
			}
			result.Messages = value.Messages
			result.Tools = value.Tools
			return result, nil
		}
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return Response{}, err
	}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || !uuid.MatchString(id) {
			continue
		}
		f, err := os.Open(filepath.Join(dir, entry.Name()))
		if err != nil {
			return Response{}, err
		}
		var value archivedConversation
		err = json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&value)
		_ = f.Close()
		if err != nil {
			return Response{}, err
		}
		result.History = append(result.History, value.HistoryEntry)
	}
	sort.Slice(result.History, func(i, j int) bool { return result.History[i].CreatedAt > result.History[j].CreatedAt })
	// Sorted before the cap, so a folded history over 32 entries shows its newest.
	if len(result.History) > 32 {
		result.History = result.History[:32]
	}
	return result, nil
}
