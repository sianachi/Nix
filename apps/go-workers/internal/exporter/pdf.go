package exporter

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

const (
	pdfLinesPerPage = 52
	pdfCharacters   = 88
)

func writePDF(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	spool, err := worktemp.Create("nix-pdf-pages-*")
	if err != nil {
		return err
	}
	path := spool.Name()
	defer func() { _ = os.Remove(path) }()

	pages, err := spoolPDFPages(spool, next, limits, report)
	closeErr := spool.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if pages == 0 {
		return errors.New("cannot export an empty PDF")
	}

	input, err := os.Open(path)
	if err != nil {
		return err
	}
	defer input.Close()
	return assemblePDF(output, input, pages, limits.MaxBytes)
}

func spoolPDFPages(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) (int, error) {
	limited := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	lines := make([]string, 0, pdfLinesPerPage)
	pages, records := 0, 0
	flush := func() error {
		if len(lines) == 0 {
			return nil
		}
		content := pdfPageContent(lines)
		if len(content) > int(^uint32(0)) {
			return stream.ErrLimitExceeded
		}
		if err := binary.Write(limited, binary.BigEndian, uint32(len(content))); err != nil {
			return err
		}
		if _, err := io.WriteString(limited, content); err != nil {
			return err
		}
		pages++
		lines = lines[:0]
		return nil
	}
	add := func(line string) error {
		for _, wrapped := range wrapPDFLine(line) {
			if len(lines) == pdfLinesPerPage {
				if err := flush(); err != nil {
					return err
				}
			}
			lines = append(lines, wrapped)
		}
		return nil
	}

	for {
		record, ok, err := next()
		if err != nil {
			return 0, err
		}
		if !ok {
			break
		}
		records++
		if records > limits.MaxRecords {
			return 0, stream.ErrLimitExceeded
		}
		if record.Title == "" {
			return 0, errors.New("export record title is required")
		}
		if records > 1 {
			if err := flush(); err != nil {
				return 0, err
			}
		}
		title, _ := ProjectTitle(record.Title, false)
		if err := add(title); err != nil {
			return 0, err
		}
		if err := eachMarkdownPlainLine(record.Body, add); err != nil {
			return 0, err
		}
	}
	if records == 0 {
		return 0, nil
	}
	if report != nil {
		messages := report()
		if len(messages) > 0 {
			if err := flush(); err != nil {
				return 0, err
			}
			if err := add("What did not come across"); err != nil {
				return 0, err
			}
			if err := add("The workspace still holds the information listed below."); err != nil {
				return 0, err
			}
			if err := add(""); err != nil {
				return 0, err
			}
			for _, message := range messages {
				if err := add("- " + sanitizeText(message)); err != nil {
					return 0, err
				}
			}
		}
	}
	if err := flush(); err != nil {
		return 0, err
	}
	return pages, limited.err
}

func eachMarkdownPlainLine(markdown string, consume func(string) error) error {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	inCode := false
	for index := 0; index < len(lines); index++ {
		line := strings.TrimSuffix(lines[index], "\r")
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			continue
		}
		if inCode {
			if err := consume(sanitizeText(line)); err != nil {
				return err
			}
			continue
		}
		if trimmed == "<details>" || strings.HasPrefix(trimmed, `<details data-toggle-level=`) || trimmed == "</details>" {
			continue
		}
		if strings.HasPrefix(trimmed, "<summary>") && strings.HasSuffix(trimmed, "</summary>") {
			trimmed = strings.TrimSuffix(strings.TrimPrefix(trimmed, "<summary>"), "</summary>")
		}
		if index+1 < len(lines) && strings.Contains(line, "|") && tableSeparator(lines[index+1]) {
			if err := consume(strings.Join(splitTableRow(line), " | ")); err != nil {
				return err
			}
			index++
			for index+1 < len(lines) && strings.Contains(lines[index+1], "|") && strings.TrimSpace(lines[index+1]) != "" {
				index++
				if err := consume(strings.Join(splitTableRow(lines[index]), " | ")); err != nil {
					return err
				}
			}
			continue
		}
		if _, body, ok := markdownHeading(line); ok {
			trimmed = body
		} else if body, level, ok := markdownBullet(line); ok {
			trimmed = strings.Repeat("  ", level) + "- " + body
		} else if body, level, ok := markdownOrdered(line); ok {
			trimmed = strings.Repeat("  ", level) + "1. " + body
		} else if strings.HasPrefix(trimmed, ">") {
			trimmed = "> " + strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
		}
		if trimmed == "---" || trimmed == "***" {
			trimmed = ""
		}
		if err := consume(markdownPlainInline(trimmed)); err != nil {
			return err
		}
	}
	return nil
}

func markdownPlainInline(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for len(value) > 0 {
		if value[0] == '\\' && len(value) > 1 {
			output.WriteByte(value[1])
			value = value[2:]
			continue
		}
		if strings.HasPrefix(value, "![") {
			if label, _, rest, ok := markdownLink(value[1:]); ok {
				output.WriteString("Image: ")
				output.WriteString(unescapeMarkdown(label))
				value = rest
				continue
			}
		}
		if value[0] == '[' {
			if label, _, rest, ok := markdownLink(value); ok {
				output.WriteString(unescapeMarkdown(label))
				value = rest
				continue
			}
		}
		if strings.ContainsRune("*~`", rune(value[0])) {
			value = value[1:]
			continue
		}
		output.WriteByte(value[0])
		value = value[1:]
	}
	return sanitizeText(output.String())
}

func pdfPageContent(lines []string) string {
	var content strings.Builder
	content.WriteString("BT /F1 11 Tf 50 790 Td 14 TL ")
	for index, line := range lines {
		if index > 0 {
			content.WriteString("T* ")
		}
		content.WriteByte('(')
		content.WriteString(pdfEscape(line))
		content.WriteString(") Tj ")
	}
	content.WriteString("ET")
	return content.String()
}

func assemblePDF(output io.Writer, pages io.Reader, pageCount int, maximumBytes int64) error {
	limited := &limitedWriter{writer: output, remaining: maximumBytes}
	counting := &countingWriter{writer: limited}
	objectCount := 3 + pageCount*2
	fontID := objectCount
	offsets := make([]int64, objectCount+1)
	if _, err := io.WriteString(counting, "%PDF-1.4\n"); err != nil {
		return err
	}
	if err := writePDFObject(counting, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>"); err != nil {
		return err
	}
	offsets[2] = counting.written
	if _, err := fmt.Fprintf(counting, "2 0 obj\n<< /Type /Pages /Kids ["); err != nil {
		return err
	}
	for page := 0; page < pageCount; page++ {
		if _, err := fmt.Fprintf(counting, "%d 0 R ", 3+page*2); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(counting, "] /Count %d >>\nendobj\n", pageCount); err != nil {
		return err
	}

	reader := bufio.NewReader(pages)
	for page := 0; page < pageCount; page++ {
		pageID := 3 + page*2
		contentID := pageID + 1
		pageBody := fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>",
			fontID,
			contentID)
		if err := writePDFObject(counting, offsets, pageID, pageBody); err != nil {
			return err
		}
		var length uint32
		if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
			return err
		}
		if length > 1<<20 {
			return stream.ErrLimitExceeded
		}
		content := make([]byte, int(length))
		if _, err := io.ReadFull(reader, content); err != nil {
			return err
		}
		offsets[contentID] = counting.written
		if _, err := fmt.Fprintf(counting, "%d 0 obj\n<< /Length %d >>\nstream\n", contentID, len(content)); err != nil {
			return err
		}
		if _, err := counting.Write(content); err != nil {
			return err
		}
		if _, err := io.WriteString(counting, "\nendstream\nendobj\n"); err != nil {
			return err
		}
	}
	if err := writePDFObject(counting, offsets, fontID, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); err != nil {
		return err
	}

	xref := counting.written
	if _, err := fmt.Fprintf(counting, "xref\n0 %d\n0000000000 65535 f \n", objectCount+1); err != nil {
		return err
	}
	for objectID := 1; objectID <= objectCount; objectID++ {
		if offsets[objectID] > 9_999_999_999 {
			return stream.ErrLimitExceeded
		}
		if _, err := fmt.Fprintf(counting, "%010d 00000 n \n", offsets[objectID]); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(counting, "trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", objectCount+1, xref)
	if err != nil {
		return err
	}
	return limited.err
}

func writePDFObject(output *countingWriter, offsets []int64, id int, body string) error {
	offsets[id] = output.written
	_, err := fmt.Fprintf(output, "%d 0 obj\n%s\nendobj\n", id, body)
	return err
}

func wrapPDFLine(value string) []string {
	characters := []rune(value)
	if len(characters) == 0 {
		return []string{""}
	}
	lines := make([]string, 0, len(characters)/pdfCharacters+1)
	for len(characters) > pdfCharacters {
		cut := pdfCharacters
		for index := pdfCharacters; index > pdfCharacters/2; index-- {
			if characters[index] == ' ' || characters[index] == '\t' {
				cut = index
				break
			}
		}
		lines = append(lines, strings.TrimSpace(string(characters[:cut])))
		characters = characters[cut:]
		for len(characters) > 0 && (characters[0] == ' ' || characters[0] == '\t') {
			characters = characters[1:]
		}
	}
	lines = append(lines, string(characters))
	return lines
}

func pdfEscape(value string) string {
	value = strings.Map(func(character rune) rune {
		if character < 32 || character > 126 {
			return '?'
		}
		return character
	}, value)
	return strings.NewReplacer(`\`, `\\`, `(`, `\(`, `)`, `\)`).Replace(value)
}

// PDFTextRequiresSubstitution reports text the built-in deterministic PDF font cannot carry.
func PDFTextRequiresSubstitution(value string) bool {
	for _, character := range value {
		if character < 32 || character > 126 {
			return true
		}
	}
	return false
}

type countingWriter struct {
	writer  io.Writer
	written int64
}

func (writer *countingWriter) Write(value []byte) (int, error) {
	count, err := writer.writer.Write(value)
	writer.written += int64(count)
	return count, err
}
