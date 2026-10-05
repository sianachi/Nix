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
	if err != nil || result.Records[0].Body != "Hello\n\nworld" {
		t.Fatalf("Parse() = %+v, %v", result, err)
	}
}

func TestTextImportNormalizesUtf8AndRejectsBinary(t *testing.T) {
	result, err := Parse("txt", "one", "Text", bytes.NewReader([]byte{0xef, 0xbb, 0xbf, 'a', '\r', '\n', 'b'}), Limits{MaxBytes: 100, MaxItems: 10, MaxEntry: 100})
	if err != nil || result.Records[0].Body != "a\nb" {
		t.Fatalf("Parse() = %+v, %v", result, err)
	}
	_, err = Parse("txt", "one", "Text", bytes.NewReader([]byte{'a', 0, 'b'}), Limits{MaxBytes: 100, MaxItems: 10, MaxEntry: 100})
	if err == nil {
		t.Fatal("Parse() accepted binary text")
	}
}

func TestDocxImportRejectsEntities(t *testing.T) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	entry, _ := archive.Create("word/document.xml")
	_, _ = entry.Write([]byte(`<!DOCTYPE x [<!ENTITY y "bad">]><w:document><w:p>&y;</w:p></w:document>`))
	_ = archive.Close()
	_, err := Parse("docx", "one", "Document", bytes.NewReader(output.Bytes()), Limits{MaxBytes: 1000, MaxItems: 10, MaxEntry: 1000})
	if err == nil {
		t.Fatal("Parse() accepted a DOCX XML entity")
	}
}

func TestDocxImportExtractsSupportedImages(t *testing.T) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	document, _ := archive.Create("word/document.xml")
	_, _ = document.Write([]byte(`<w:document><w:p><w:t>With image</w:t></w:p></w:document>`))
	image, _ := archive.Create("word/media/image1.png")
	_, _ = image.Write(append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 24)...))
	_ = archive.Close()
	result, err := Parse("docx", "one", "Document", bytes.NewReader(output.Bytes()), Limits{MaxBytes: 5000, MaxItems: 10, MaxEntry: 4000})
	if err != nil || len(result.Assets) != 1 || result.Assets[0].MediaType != "image/png" {
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
