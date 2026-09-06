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
	var bytes [16]byte
	if _, err = rand.Read(bytes[:]); err != nil {
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
		if len(result.History) >= 32 {
			break
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
	return result, nil
}
