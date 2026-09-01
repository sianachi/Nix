package importplan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

func FuzzValidateXMLIsBoundedAndNeverPanics(fuzz *testing.F) {
	fuzz.Add([]byte(`<w:document><w:p>text</w:p></w:document>`))
	fuzz.Add([]byte(`<!DOCTYPE x [<!ENTITY e "bad">]><x>&e;</x>`))
	fuzz.Add([]byte(`<x><y></x>`))
	fuzz.Fuzz(func(t *testing.T, body []byte) {
		if len(body) > 64<<10 {
			body = body[:64<<10]
		}
		_ = validateXML(body, 32, 20_000)
	})
}

func FuzzTextImportNeverAcceptsInvalidUTF8OrControlBytes(fuzz *testing.F) {
	fuzz.Add([]byte("plain text\r\n"))
	fuzz.Add([]byte{'a', 0, 'b'})
	fuzz.Add([]byte{0xff, 0xfe})
	fuzz.Fuzz(func(t *testing.T, body []byte) {
		if len(body) > 64<<10 {
			body = body[:64<<10]
		}
		path := filepath.Join(t.TempDir(), "input.txt")
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(body)
		source := Source{
			Path: path, Format: "txt", Title: "Imported", FileName: "input.txt",
			MediaType: "text/plain", Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:]),
		}
		plan, err := Parse(context.Background(), source, testLimits())
		if err == nil && (binaryLookingText(body) || !validTextWithOptionalBOM(body)) {
			t.Fatalf("invalid text was accepted: %#v", plan)
		}
	})
}

func FuzzDOCXAndNixArchivesFailClosed(fuzz *testing.F) {
	fuzz.Add("docx", []byte("not a zip"))
	fuzz.Add("nix", []byte("PK\x03\x04"))
	fuzz.Fuzz(func(t *testing.T, format string, body []byte) {
		if format != "docx" && format != "nix" {
			return
		}
		if len(body) > 256<<10 {
			body = body[:256<<10]
		}
		path := filepath.Join(t.TempDir(), "input."+format)
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(body)
		_, _ = Parse(context.Background(), Source{
			Path: path, Format: format, Title: "Imported", FileName: filepath.Base(path),
			MediaType: "application/octet-stream", Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:]),
		}, testLimits())
		if format == "nix" {
			_, _ = ParseTemplate(context.Background(), Source{
				Path: path, Format: format, Title: "Imported", FileName: filepath.Base(path),
				MediaType: "application/octet-stream", Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:]),
			}, testLimits())
		}
	})
}

func validTextWithOptionalBOM(body []byte) bool {
	if len(body) >= 3 && body[0] == 0xef && body[1] == 0xbb && body[2] == 0xbf {
		body = body[3:]
	}
	return !binaryLookingText(body) && utf8.Valid(body)
}
