package index

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

var ErrCapacityExceeded = errors.New("index capacity exceeded")

type Result struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Score int    `json:"score"`
}

type Index struct {
	mu         sync.RWMutex
	byToken    map[string]map[string]struct{}
	records    map[string]stream.Record
	maxTokens  int
	maxRecords int
}

func New(maxTokens, maxRecords int) *Index {
	if maxTokens <= 0 {
		maxTokens = 20_000
	}
	if maxRecords <= 0 {
		maxRecords = 100_000
	}
	return &Index{byToken: make(map[string]map[string]struct{}), records: make(map[string]stream.Record), maxTokens: maxTokens, maxRecords: maxRecords}
}

func (index *Index) Put(record stream.Record) error {
	index.mu.Lock()
	defer index.mu.Unlock()
	if _, exists := index.records[record.ID]; !exists && len(index.records) >= index.maxRecords {
		return ErrCapacityExceeded
	}
	index.removeLocked(record.ID)
	index.records[record.ID] = record
	seen := make(map[string]struct{})
	for position, token := range tokenize(record) {
		if position >= index.maxTokens {
			break
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		items := index.byToken[token]
		if items == nil {
			items = make(map[string]struct{})
			index.byToken[token] = items
		}
		items[record.ID] = struct{}{}
	}
	return nil
}

func (index *Index) Remove(id string) {
	index.mu.Lock()
	defer index.mu.Unlock()
	index.removeLocked(id)
}

func (index *Index) removeLocked(id string) {
	if _, exists := index.records[id]; !exists {
		return
	}
	delete(index.records, id)
	for token, items := range index.byToken {
		delete(items, id)
		if len(items) == 0 {
			delete(index.byToken, token)
		}
	}
}

func (index *Index) Search(query string, limit int) []Result {
	if limit <= 0 {
		return nil
	}
	scores := make(map[string]int)
	for _, token := range tokenizeText(query) {
		for id := range index.byToken[token] {
			scores[id]++
		}
	}
	results := make([]Result, 0, len(scores))
	for id, score := range scores {
		record := index.records[id]
		results = append(results, Result{ID: id, Title: record.Title, Score: score})
	}
	sort.Slice(results, func(left, right int) bool {
		if results[left].Score != results[right].Score {
			return results[left].Score > results[right].Score
		}
		return results[left].ID < results[right].ID
	})
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

func (index *Index) Len() int {
	index.mu.RLock()
	defer index.mu.RUnlock()
	return len(index.records)
}

func tokenize(record stream.Record) []string {
	return tokenizeText(record.Title + " " + record.Body + " " + propertiesText(record.Properties))
}

func propertiesText(properties map[string]any) string {
	var builder strings.Builder
	for key, value := range properties {
		builder.WriteString(key)
		builder.WriteByte(' ')
		builder.WriteString(strings.TrimSpace(toText(value)))
		builder.WriteByte(' ')
	}
	return builder.String()
}

func toText(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func tokenizeText(text string) []string {
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	result := make([]string, 0, len(words))
	for _, word := range words {
		if len([]rune(word)) >= 2 {
			result = append(result, word)
		}
	}
	return result
}
