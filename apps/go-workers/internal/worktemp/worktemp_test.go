package worktemp

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSweepRemovesOnlyOldOwnedRegularFiles(t *testing.T) {
	now := time.Now().UTC()
	directory, err := ensureDirectory()
	if err != nil {
		t.Fatal(err)
	}
	old, err := Create("nix-export-*")
	if err != nil {
		t.Fatal(err)
	}
	oldPath := old.Name()
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldPath, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	fresh, err := Create("nix-export-*")
	if err != nil {
		t.Fatal(err)
	}
	freshPath := fresh.Name()
	if err := fresh.Close(); err != nil {
		t.Fatal(err)
	}
	unowned := filepath.Join(directory, "unrelated-file")
	if err := os.WriteFile(unowned, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Remove(oldPath)
		_ = os.Remove(freshPath)
		_ = os.Remove(unowned)
	})

	if err := Sweep(now, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old owned file remains: %v", err)
	}
	if _, err := os.Stat(freshPath); err != nil {
		t.Fatalf("fresh owned file was removed: %v", err)
	}
	if _, err := os.Stat(unowned); err != nil {
		t.Fatalf("unowned file was removed: %v", err)
	}
}

func TestCreateRejectsPatternsOutsideTheOwnedPrefixes(t *testing.T) {
	if _, err := Create("other-*"); err == nil {
		t.Fatal("Create accepted an unowned prefix")
	}
}
