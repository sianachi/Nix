package nixarchive

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
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

func TestWriteStreamPreservesUnknownSourceFieldsForLosslessArchives(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	streamBody := `{"format":"nix-archive","formatVersion":1,"schemaVersion":99,"exportedAt":"2026-08-31T00:00:00Z","root":"` + root + `","rootEffectiveSchema":null,"includesDeleted":false,"items":[{"id":"` + root + `","parentId":null,"seq":"1","title":"Root","type":"future"}],"omitted":[],"loss":[],"futureManifest":{"kept":true}}` + "\n" +
		`{"id":"` + root + `","parentId":null,"workspaceId":"workspace","type":"future","title":"Root","seq":"1","lifecycleState":"active","createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","properties":{},"schema":null,"views":null,"viewRows":[],"viewRowsTruncated":false,"body":{"schemaVersion":99,"futureBody":{"kept":true}},"futureBundle":{"kept":true}}` + "\n" +
		`{"end":true,"items":1}` + "\n"
	input, err := OpenBundleStream(bytes.NewBufferString(streamBody), stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := WriteStream(&output, input.Manifest, input.Next, 1<<20); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range archive.File {
		body, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		content, readErr := io.ReadAll(body)
		_ = body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if entry.Name == "manifest.json" && !bytes.Contains(content, []byte(`"futureManifest":{"kept":true}`)) {
			t.Fatal("unknown manifest field was discarded")
		}
		if entry.Name == "items/"+root+".json" && !bytes.Contains(content, []byte(`"futureBundle":{"kept":true}`)) {
			t.Fatal("unknown bundle field was discarded")
		}
	}
}
