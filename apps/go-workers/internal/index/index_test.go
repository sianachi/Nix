package index

import (
	"errors"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestIndexRanksRecordsByMatchingTerms(t *testing.T) {
	search := New(100, 10)
	search.Put(stream.Record{ID: "one", Title: "Project plan", Body: "A plan for launch"})
	search.Put(stream.Record{ID: "two", Title: "Launch notes", Body: "A retrospective"})
	results := search.Search("project launch plan", 10)
	if len(results) != 2 || results[0].ID != "one" || results[0].Score != 3 {
		t.Fatalf("Search() = %+v", results)
	}
}

func TestIndexReplacesStaleTokens(t *testing.T) {
	search := New(100, 10)
	search.Put(stream.Record{ID: "one", Title: "Old title"})
	search.Put(stream.Record{ID: "one", Title: "New title"})
	if got := search.Search("old", 10); len(got) != 0 {
		t.Fatalf("stale search results = %+v", got)
	}
}

func TestIndexRefusesNewRecordsPastCapacity(t *testing.T) {
	search := New(100, 1)
	if err := search.Put(stream.Record{ID: "one", Title: "One"}); err != nil {
		t.Fatalf("first Put() error = %v", err)
	}
	if err := search.Put(stream.Record{ID: "two", Title: "Two"}); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("second Put() error = %v, want ErrCapacityExceeded", err)
	}
}

func TestIndexUpdatesAreSafeConcurrently(t *testing.T) {
	search := New(100, 20)
	done := make(chan struct{}, 20)
	for number := 0; number < 20; number++ {
		go func(number int) {
			search.Put(stream.Record{ID: string(rune('a' + number)), Title: "Concurrent record"})
			done <- struct{}{}
		}(number)
	}
	for number := 0; number < 20; number++ {
		<-done
	}
	if search.Len() != 20 {
		t.Fatalf("Len() = %d, want 20", search.Len())
	}
}
