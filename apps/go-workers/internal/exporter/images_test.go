package exporter

import (
	"archive/zip"
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestNoteImageExportsEmbedBytesAndPreserveSize(t *testing.T) {
	var raster bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 320, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 320; x++ {
			picture.Set(x, y, color.RGBA{uint8(x % 255), 100, uint8(y), 255})
		}
	}
	if err := png.Encode(&raster, picture); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"schemaVersion":4,"prosemirror":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Image notes"}]},{"type":"image","attrs":{"fileItemId":"11111111-1111-4111-8111-111111111111","src":"","alt":"Sample image","width":240,"height":null}}]}}`)
	markdown, images, losses, err := ProjectBodyWithImages(body, 1<<20, func(id string) ([]byte, error) { return raster.Bytes(), nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 || images[0].Width != 240 || len(losses) != 0 {
		t.Fatalf("image count=%d losses=%v", len(images), losses)
	}
	records := []stream.Record{{ID: "note", Title: "Resized image", Body: markdown, Images: images}}
	limits := stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 10}
	for _, format := range []string{"pdf", "docx", "markdown"} {
		t.Run(format, func(t *testing.T) {
			var output bytes.Buffer
			if err := Write(format, records, &output, limits); err != nil {
				t.Fatal(err)
			}
			switch format {
			case "pdf":
				if !bytes.Contains(output.Bytes(), []byte("/Subtype /Image")) {
					t.Fatal("missing PDF image")
				}
				if text := extractPDFText(t, output.Bytes()); !strings.Contains(text, "Image notes") {
					t.Fatal(text)
				}
				saveQA(t, "image.pdf", output.Bytes())
			case "docx":
				archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
				if err != nil {
					t.Fatal(err)
				}
				foundImage, foundDrawing := false, false
				for _, file := range archive.File {
					reader, err := file.Open()
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(reader)
					reader.Close()
					if err != nil {
						t.Fatal(err)
					}
					if file.Name == "word/media/image1.png" {
						foundImage = bytes.Equal(data, raster.Bytes())
					}
					if file.Name == "word/document.xml" {
						foundDrawing = bytes.Contains(data, []byte(`cx="2286000" cy="1143000"`))
					}
				}
				if !foundImage || !foundDrawing {
					t.Fatal("missing embedded image or saved dimensions")
				}
			case "markdown":
				if !strings.Contains(output.String(), "data:image/png;base64,") || strings.Contains(output.String(), "nix.invalid") {
					t.Fatal("missing portable image")
				}
			}
		})
	}
}

func TestInvalidImageFallsBackWithAnExplicitLoss(t *testing.T) {
	body := []byte(`{"schemaVersion":4,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"fileItemId":"file","alt":"Unavailable figure"}}]}}`)
	markdown, images, losses, err := ProjectBodyWithImages(body, 1<<20, func(string) ([]byte, error) { return []byte("not an image"), nil })
	if err != nil || len(images) != 0 || len(losses) == 0 || !strings.Contains(markdown, "Unavailable figure") {
		t.Fatalf("%s %v %v", markdown, losses, err)
	}
}

func TestPDFFormatsUnicodeListsTablesAndLongContent(t *testing.T) {
	body := "## Résumé – café\n\n**Bold** and *italic* with `code`.\n\n1. First\n2. Second\n\n| Column | Value |\n| --- | --- |\n| Alpha | " + strings.Repeat("long cell ", 120) + " |\n\n```go\nfmt.Println(\"hello\")\n```\n\n<!-- nix-page-break -->\n\n## Next page\n"
	var output bytes.Buffer
	if err := Write("pdf", []stream.Record{{ID: "one", Title: "Formatting sample", Body: body}}, &output, stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 10}); err != nil {
		t.Fatal(err)
	}
	text := extractPDFText(t, output.Bytes())
	for _, want := range []string{"Résumé – café", "Bold", "italic", "1. First", "2. Second", "Next page"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	saveQA(t, "formatting.pdf", output.Bytes())
}
func saveQA(t *testing.T, name string, data []byte) {
	t.Helper()
	if dir := os.Getenv("NIX_EXPORT_QA_DIR"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPDFPageBudgetStopsPathologicalDocuments(t *testing.T) {
	var output bytes.Buffer
	err := Write("pdf", []stream.Record{{ID: "one", Title: "Page limit", Body: strings.Repeat("<!-- nix-page-break -->\n", maximumPDFPages)}}, &output, stream.Limits{MaxBytes: 2 << 20, MaxLine: 1 << 20, MaxRecords: 1})
	if !errors.Is(err, stream.ErrLimitExceeded) {
		t.Fatalf("expected page limit, got %v", err)
	}
}
