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

// writeArchive stores c as one new read-only history entry in dir.
func writeArchive(dir string, c *conversation) error {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return err
	}
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	id := fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
	title := []rune(c.Messages[0].Text)
	if len(title) > 120 {
		title = title[:120]
	}
	value := archivedConversation{HistoryEntry: HistoryEntry{id, string(title), time.Now().UTC().Format(time.RFC3339)}, Messages: c.Messages, Tools: c.Tools}
	path := filepath.Join(dir, id+".json")
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

func (a *account) history(key string, r Request) (Response, error) {
	dir := filepath.Join(a.home, key+"-history")
	result := a.snapshot("")
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
			f, err := os.Open(path)
			if err != nil {
				return Response{}, err
			}
			defer f.Close()
			var value archivedConversation
			if json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&value) != nil {
				return Response{}, errors.New("history could not be loaded")
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
