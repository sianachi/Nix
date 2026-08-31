package exporter

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"strconv"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func Write(format string, records []stream.Record, output io.Writer, limits stream.Limits) error {
	if len(records) > limits.MaxRecords {
		return stream.ErrLimitExceeded
	}
	switch strings.ToLower(format) {
	case "ndjson", "jsonl":
		_, err := stream.WriteRecords(output, records, limits)
		return err
	case "markdown", "md":
		return writeMarkdown(output, records, limits)
	case "nix":
		return writeNix(output, records, limits)
	case "docx":
		return writeDOCX(output, records, limits)
	case "pdf":
		return writePDF(output, records, limits)
	default:
		return fmt.Errorf("unsupported export format: %s", format)
	}
}

func writeDOCX(output io.Writer, records []stream.Record, limits stream.Limits) error {
	limitedOutput := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	archive := zip.NewWriter(limitedOutput)
	entries := []struct{ name, body string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`},
		{"word/document.xml", docxDocument(records)},
	}
	for _, entry := range entries {
		if err := writeZipEntry(archive, entry.name, []byte(entry.body), limits); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limitedOutput.err
}

func docxDocument(records []stream.Record) string {
	var body strings.Builder
	for _, record := range records {
		body.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>`)
		body.WriteString(html.EscapeString(record.Title))
		body.WriteString(`</w:t></w:r></w:p>`)
		for _, line := range strings.Split(record.Body, "\n") {
			body.WriteString(`<w:p><w:r><w:t xml:space="preserve">`)
			body.WriteString(html.EscapeString(line))
			body.WriteString(`</w:t></w:r></w:p>`)
		}
	}
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body.String() + `<w:sectPr/></w:body></w:document>`
}

func writePDF(output io.Writer, records []stream.Record, limits stream.Limits) error {
	lines := make([]string, 0, len(records)*2)
	for _, record := range records {
		lines = append(lines, record.Title)
		lines = append(lines, strings.Split(record.Body, "\n")...)
	}
	var content strings.Builder
	content.WriteString("BT /F1 12 Tf 50 790 Td 14 TL ")
	for index, line := range lines {
		if index > 0 {
			content.WriteString("T* ")
		}
		content.WriteByte('(')
		content.WriteString(pdfEscape(line))
		content.WriteString(") Tj ")
	}
	content.WriteString("ET")
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", content.Len(), content.String()),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var document bytes.Buffer
	document.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = document.Len()
		fmt.Fprintf(&document, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := document.Len()
	fmt.Fprintf(&document, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for index := 1; index <= len(objects); index++ {
		fmt.Fprintf(&document, "%010d 00000 n \n", offsets[index])
	}
	fmt.Fprintf(&document, "trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	if int64(document.Len()) > limits.MaxBytes {
		return stream.ErrLimitExceeded
	}
	_, err := document.WriteTo(output)
	return err
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

func writeMarkdown(output io.Writer, records []stream.Record, limits stream.Limits) error {
	var bytesWritten int64
	for _, record := range records {
		body := strings.TrimSpace(record.Body)
		text := "# " + record.Title + "\n\n" + body + "\n\n"
		if bytesWritten+int64(len(text)) > limits.MaxBytes {
			return stream.ErrLimitExceeded
		}
		if _, err := io.WriteString(output, text); err != nil {
			return err
		}
		bytesWritten += int64(len(text))
	}
	return nil
}

func writeNix(output io.Writer, records []stream.Record, limits stream.Limits) error {
	if len(records) == 0 {
		return errors.New("cannot export an empty Nix archive")
	}
	limitedOutput := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	archive := zip.NewWriter(limitedOutput)
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 1,
		"exportedAt": "1970-01-01T00:00:00Z", "root": records[0].ID,
		"rootEffectiveSchema": nil, "includesDeleted": false, "items": make([]map[string]any, 0, len(records)),
		"omitted": []any{}, "loss": []any{},
	}
	items := manifest["items"].([]map[string]any)
	for position, record := range records {
		if record.ID == "" || record.Title == "" {
			return errors.New("every exported record must contain id and title")
		}
		if strings.Contains(record.ID, "/") || strings.Contains(record.ID, "\\") || strings.Contains(record.ID, "..") {
			return fmt.Errorf("unsafe item identifier: %s", record.ID)
		}
		items = append(items, map[string]any{"id": record.ID, "parentId": nullable(record.ParentID), "seq": strconv.Itoa(position), "title": record.Title, "type": "note"})
	}
	manifest["items"] = items
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := writeZipEntry(archive, "manifest.json", manifestBytes, limits); err != nil {
		return err
	}
	for _, record := range records {
		payload, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			return marshalErr
		}
		if err := writeZipEntry(archive, "items/"+record.ID+".json", payload, limits); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limitedOutput.err
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
	err       error
}

func (writer *limitedWriter) Write(value []byte) (int, error) {
	if writer.err != nil {
		return 0, writer.err
	}
	if int64(len(value)) > writer.remaining {
		writer.err = stream.ErrLimitExceeded
		return 0, writer.err
	}
	written, err := writer.writer.Write(value)
	writer.remaining -= int64(written)
	if err != nil {
		writer.err = err
	}
	return written, err
}

func writeZipEntry(archive *zip.Writer, name string, body []byte, limits stream.Limits) error {
	if len(body) > limits.MaxLine {
		return stream.ErrLimitExceeded
	}
	entry, err := archive.Create(name)
	if err != nil {
		return err
	}
	_, err = entry.Write(body)
	return err
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
