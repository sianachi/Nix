package nixarchive

import "testing"

func TestManifestValidationRejectsUnsafeAndDuplicateItems(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{Format: Format, FormatVersion: FormatVersion, Root: root, Items: []ManifestItem{{ID: root, Title: "Root", Seq: "0"}}}
	if err := ValidateManifest(manifest, 10); err != nil {
		t.Fatal(err)
	}
	manifest.Items = append(manifest.Items, ManifestItem{ID: root, Title: "Duplicate", Seq: "1"})
	if err := ValidateManifest(manifest, 10); err == nil {
		t.Fatal("duplicate item accepted")
	}
}
