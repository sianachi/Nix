package importer

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestMarkdownImportPreservesText(t *testing.T) {
	result, err := Parse("markdown", "one", "A note", strings.NewReader("# Heading\n\nText"), Limits{MaxBytes: 100, MaxItems: 10, MaxEntry: 100})
	if err != nil || len(result.Records) != 1 || result.Records[0].Body != "# Heading\n\nText" {
		t.Fatalf("Parse() = %+v, %v", result, err)
	}
}

func TestDocxImportExtractsWordText(t *testing.T) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	entry, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte(`<w:document><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:t>world</w:t></w:p></w:document>`))
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := Parse("docx", "one", "A document", bytes.NewReader(output.Bytes()), Limits{MaxBytes: 1000, MaxItems: 10, MaxEntry: 1000})
	if err != nil || result.Records[0].Body != "Hello world" {
		t.Fatalf("Parse() = %+v, %v", result, err)
	}
}

func TestNixImportRequiresTheNativeManifest(t *testing.T) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	manifest, _ := archive.Create("manifest.json")
	_, _ = manifest.Write([]byte(`{"format":"not-nix"}`))
	_ = archive.Close()
	_, err := Parse("nix", "one", "A bundle", bytes.NewReader(output.Bytes()), Limits{MaxBytes: 1000, MaxItems: 10, MaxEntry: 1000})
	if err == nil {
		t.Fatal("Parse() accepted a non-Nix archive")
	}
}

func TestImportRefusesOversizedSource(t *testing.T) {
	_, err := Parse("markdown", "one", "A note", strings.NewReader("too large"), Limits{MaxBytes: 3, MaxItems: 10, MaxEntry: 100})
	if !errors.Is(err, stream.ErrLimitExceeded) {
		t.Fatalf("Parse() error = %v, want ErrLimitExceeded", err)
	}
}
