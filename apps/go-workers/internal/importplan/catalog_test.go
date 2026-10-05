package importplan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestBuiltInTemplateCatalogParsesInGoImportReader(t *testing.T) {
	directory := filepath.Join("..", "..", "..", "..", "packages", "template-catalog", "templates")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".nix") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) != 10 {
		t.Fatalf("catalog contains %d archives, want ten", len(names))
	}

	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(directory, name)
			bytes, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(bytes)
			source := Source{
				Path: path, Format: "nix", Title: name, FileName: name, MediaType: "application/x-nix-template",
				Bytes: int64(len(bytes)), SHA256: hex.EncodeToString(digest[:]),
			}
			plan, err := ParseTemplate(context.Background(), source, testLimits())
			if err != nil {
				t.Fatal(err)
			}
			if plan.Profile.Key != strings.TrimSuffix(name, ".nix") || plan.ItemCount < 5 || plan.BodyCount == 0 || plan.ViewCount == 0 {
				t.Fatalf("parsed catalog plan is incomplete: %#v", plan)
			}
			hasAssignee := false
			for _, item := range plan.Items {
				if !isJSONNull(item.Schema) && strings.Contains(string(item.Schema), `"type":"assignee"`) {
					hasAssignee = true
					break
				}
			}
			if !hasAssignee {
				t.Fatal("native assignee schema was not preserved in the Go plan")
			}
		})
	}
}
