package exporter

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
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
	default:
		return fmt.Errorf("unsupported export format: %s", format)
	}
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
