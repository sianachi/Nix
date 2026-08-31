package exporter

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestMarkdownExportIsDeterministic(t *testing.T) {
	var output bytes.Buffer
	err := Write("markdown", []stream.Record{{ID: "one", Title: "One", Body: "Body"}}, &output, stream.Limits{MaxBytes: 1000, MaxLine: 1000, MaxRecords: 10})
	if err != nil || output.String() != "# One\n\nBody\n\n" {
		t.Fatalf("Write() = %q, %v", output.String(), err)
	}
}

func TestNixExportWritesManifestBeforePayloads(t *testing.T) {
	var output bytes.Buffer
	err := Write("nix", []stream.Record{{ID: "one", Title: "One"}}, &output, stream.Limits{MaxBytes: 1000, MaxLine: 1000, MaxRecords: 10})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil || len(archive.File) != 2 || archive.File[0].Name != "manifest.json" {
		t.Fatalf("archive = %+v, %v", archive, err)
	}
}

func TestExportRefusesOversizedMarkdown(t *testing.T) {
	err := Write("md", []stream.Record{{ID: "one", Title: "One", Body: strings.Repeat("x", 100)}}, &bytes.Buffer{}, stream.Limits{MaxBytes: 10, MaxLine: 1000, MaxRecords: 10})
	if err != stream.ErrLimitExceeded {
		t.Fatalf("Write() error = %v, want ErrLimitExceeded", err)
	}
}

func TestWriteProducesDOCXAndPDF(t *testing.T) {
	records := []stream.Record{{ID: "one", Title: "Title", Body: "Body"}}
	limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	for _, format := range []string{"docx", "pdf"} {
		var output bytes.Buffer
		if err := Write(format, records, &output, limits); err != nil {
			t.Fatalf("Write(%s) error = %v", format, err)
		}
		if output.Len() == 0 {
			t.Fatalf("Write(%s) produced no output", format)
		}
	}
}
