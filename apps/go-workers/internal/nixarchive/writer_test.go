package nixarchive

import (
	"archive/zip"
	"bytes"
	"errors"
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

func TestWriteRefusesFileItemBeforeWritingArchiveBytes(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{
		Format: Format, FormatVersion: FormatVersion, Root: root,
		Items: []ManifestItem{{ID: root, Title: "Diagram", Seq: "1", Type: "file"}},
	}
	var output bytes.Buffer
	err := Write(&output, manifest, []Bundle{{ID: root, Type: "file", Title: "Diagram"}}, 1<<20)
	if !errors.Is(err, ErrFileBytesUnsupported) {
		t.Fatalf("Write() error = %v, want ErrFileBytesUnsupported", err)
	}
	if output.Len() != 0 {
		t.Fatalf("file-item refusal wrote %d archive bytes", output.Len())
	}
}

func TestWriteRefusesBodiesWithDurableFileReferencesBeforeClosingArchive(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	fileID := "223e4567-e89b-12d3-a456-426614174000"
	tests := []struct {
		name string
		body string
	}{
		{
			name: "note fileItemId",
			body: `{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"","fileItemId":"` + fileID + `"}}]}}`,
		},
		{
			name: "legacy note nix-file source",
			body: `{"schemaVersion":2,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"nix-file:` + fileID + `"}}]}}`,
		},
		{
			name: "canonical canvas marker",
			body: `{"schemaVersion":3,"canvas":{"elements":{"image":{"type":"image","customData":{"nix":{"kind":"file","itemId":"` + fileID + `"}}}}}}`,
		},
		{
			name: "transitional canvas image item",
			body: `{"schemaVersion":2,"canvas":{"elements":{"image":{"type":"image","imageItemId":"` + fileID + `"}}}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := Manifest{
				Format: Format, FormatVersion: FormatVersion, Root: root,
				Items: []ManifestItem{{ID: root, Title: "Root", Seq: "1", Type: "note"}},
			}
			var output bytes.Buffer
			err := Write(
				&output,
				manifest,
				[]Bundle{{ID: root, Type: "note", Title: "Root", Body: []byte(test.body)}},
				1<<20,
			)
			if !errors.Is(err, ErrFileBytesUnsupported) {
				t.Fatalf("Write() error = %v, want ErrFileBytesUnsupported", err)
			}
			if _, openErr := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); openErr == nil {
				t.Fatal("refusal completed a readable archive")
			}
		})
	}
}

func TestWriteAllowsRemoteNoteImageWithoutNixOwnedBytes(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	manifest := Manifest{
		Format: Format, FormatVersion: FormatVersion, Root: root,
		Items: []ManifestItem{{ID: root, Title: "Root", Seq: "1", Type: "note"}},
	}
	bundle := Bundle{
		ID: root, Type: "note", Title: "Root",
		Body: []byte(`{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"https://example.test/image.png"}}]}}`),
	}
	var output bytes.Buffer
	if err := Write(&output, manifest, []Bundle{bundle}, 1<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err != nil {
		t.Fatalf("remote image archive did not close: %v", err)
	}
}
