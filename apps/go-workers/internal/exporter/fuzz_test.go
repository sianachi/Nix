package exporter

import (
	"bytes"
	"errors"
	"testing"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func FuzzProseProjectionFailsClosedWithinItsOutputLimit(fuzz *testing.F) {
	fuzz.Add([]byte(`{"schemaVersion":2,"prosemirror":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}}`))
	fuzz.Add([]byte(`{"schemaVersion":2,"prosemirror":{"type":"doc","content":[]}} trailing`))
	fuzz.Add([]byte{0xff, 0xfe, 0x00})
	fuzz.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 32<<10 {
			return
		}
		output, _, err := ProjectBody(input, true, 4096)
		if err != nil {
			return
		}
		if len(output) > 4096 || !utf8.ValidString(output) {
			t.Fatalf("projection escaped its bounds: bytes=%d validUTF8=%v", len(output), utf8.ValidString(output))
		}
	})
}

func FuzzDocumentWritersRemainBoundedOnMarkdownInput(fuzz *testing.F) {
	fuzz.Add("## Heading\n\n**bold** [link](https://example.test)\n")
	fuzz.Add("| A | B |\n| --- | --- |\n| 1 | 2 |\n")
	fuzz.Add("```\nunterminated code")
	fuzz.Fuzz(func(t *testing.T, input string) {
		if len(input) > 32<<10 || !utf8.ValidString(input) {
			return
		}
		limits := stream.Limits{MaxBytes: 1 << 20, MaxLine: 64 << 10, MaxRecords: 1}
		for _, format := range []string{"markdown", "docx", "pdf"} {
			var output bytes.Buffer
			err := Write(format, []stream.Record{{ID: "one", Title: "Title", Body: input}}, &output, limits)
			if err != nil && !errors.Is(err, stream.ErrLimitExceeded) {
				t.Fatalf("Write(%s) failed unexpectedly: %v", format, err)
			}
			if int64(output.Len()) > limits.MaxBytes {
				t.Fatalf("Write(%s) exceeded output limit: %d", format, output.Len())
			}
		}
	})
}
