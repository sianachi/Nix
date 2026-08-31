package nixarchive

import (
	"bytes"
	"testing"
)

func TestWriteProducesManifestFirstLosslessArchive(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{Format: Format, FormatVersion: FormatVersion, Root: root, Items: []ManifestItem{{ID: root, Title: "Root", Seq: "0"}}}
	var output bytes.Buffer
	if err := Write(&output, manifest, []Bundle{{ID: root, Title: "Root", Properties: map[string]any{}, Body: []byte(`{"body":"prose"}`)}}, 1024*1024); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(output.Bytes(), []byte("manifest.json")) {
		t.Fatal("archive did not contain its manifest")
	}
}
