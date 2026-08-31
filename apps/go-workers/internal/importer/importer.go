package importer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

var ErrUnsupportedFormat = errors.New("unsupported import format")

type Limits struct {
	MaxBytes int64
	MaxItems int
	MaxEntry int64
}

type Result struct {
	Records []stream.Record `json:"records"`
	Loss    []string        `json:"loss,omitempty"`
}

func Parse(format, id, title string, source io.Reader, limits Limits) (Result, error) {
	if id == "" || title == "" {
		return Result{}, errors.New("id and title are required")
	}
	if limits.MaxBytes <= 0 || limits.MaxItems <= 0 || limits.MaxEntry <= 0 {
		return Result{}, errors.New("import limits must be positive")
	}
	switch strings.ToLower(format) {
	case "markdown", "md", "text", "txt":
		return markdown(id, title, source, limits.MaxBytes)
	case "docx":
		return docx(id, title, source, limits)
	case "pdf":
		return pdf(id, title, source, limits.MaxBytes)
	case "nix":
		return nix(id, title, source, limits)
	default:
		return Result{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, format)
	}
}

func markdown(id, title string, source io.Reader, maxBytes int64) (Result, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return Result{}, err
	}
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: string(body)}}}, nil
}

func docx(id, title string, source io.Reader, limits Limits) (Result, error) {
	archive, err := readZip(source, limits.MaxBytes, limits.MaxItems+10)
	if err != nil {
		return Result{}, err
	}
	document, err := archiveEntry(archive, "word/document.xml", limits.MaxEntry)
	if err != nil {
		return Result{}, err
	}
	text, err := xmlText(document)
	if err != nil {
		return Result{}, fmt.Errorf("DOCX document.xml: %w", err)
	}
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: text}}}, nil
}

func pdf(id, title string, source io.Reader, maxBytes int64) (Result, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return Result{}, err
	}
	if !bytes.HasPrefix(body, []byte("%PDF-")) {
		return Result{}, errors.New("PDF input does not start with a PDF signature")
	}
	text := pdfText(body)
	return Result{Records: []stream.Record{{ID: id, Title: title, Body: text}}, Loss: []string{"PDF layout, images, and non-text content are not preserved."}}, nil
}

func nix(id, title string, source io.Reader, limits Limits) (Result, error) {
	archive, err := readZip(source, limits.MaxBytes, limits.MaxItems+1)
	if err != nil {
		return Result{}, err
	}
	manifestBytes, err := archiveEntry(archive, "manifest.json", limits.MaxEntry)
	if err != nil {
		return Result{}, err
	}
	var manifest nixarchive.Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return Result{}, fmt.Errorf("archive manifest: %w", err)
	}
	if err := nixarchive.ValidateManifest(manifest, limits.MaxItems); err != nil {
		return Result{}, err
	}
	expected := make(map[string]nixarchive.ManifestItem, len(manifest.Items))
	for _, item := range manifest.Items {
		expected[item.ID] = item
	}
	var records []stream.Record
	for _, entry := range archive.File {
		if !strings.HasPrefix(entry.Name, "items/") || !strings.HasSuffix(entry.Name, ".json") {
			continue
		}
		if len(records) >= limits.MaxItems {
			return Result{}, stream.ErrLimitExceeded
		}
		payload, readErr := archiveEntry(archive, entry.Name, limits.MaxEntry)
		if readErr != nil {
			return Result{}, readErr
		}
		var bundle nixarchive.Bundle
		if parseErr := json.Unmarshal(payload, &bundle); parseErr != nil {
			return Result{}, fmt.Errorf("%s: %w", entry.Name, parseErr)
		}
		manifestItem, ok := expected[bundle.ID]
		if !ok || !strings.HasSuffix(entry.Name, "/"+bundle.ID+".json") {
			return Result{}, fmt.Errorf("%s is not listed by the manifest", entry.Name)
		}
		if bundle.Title == "" {
			bundle.Title = manifestItem.Title
		}
		body := string(bundle.Body)
		records = append(records, stream.Record{ID: bundle.ID, ParentID: valueOrEmpty(bundle.ParentID), Title: bundle.Title, Body: body, Properties: bundle.Properties})
	}
	if len(records) == 0 {
		return Result{}, errors.New("archive contains no item payloads")
	}
	if records[0].ID == id {
		records[0].Title = title
	}
	return Result{Records: records}, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func readBounded(source io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(source, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, stream.ErrLimitExceeded
	}
	return body, nil
}

func readZip(source io.Reader, maxBytes int64, maxEntries int) (*zip.Reader, error) {
	body, err := readBounded(source, maxBytes)
	if err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, err
	}
	if len(archive.File) > maxEntries {
		return nil, stream.ErrLimitExceeded
	}
	var expandedBytes uint64
	for _, entry := range archive.File {
		expandedBytes += entry.UncompressedSize64
		if expandedBytes > uint64(maxBytes) {
			return nil, stream.ErrLimitExceeded
		}
	}
	return archive, nil
}

func archiveEntry(archive *zip.Reader, name string, maxBytes int64) ([]byte, error) {
	for _, entry := range archive.File {
		if entry.Name != name {
			continue
		}
		if entry.UncompressedSize64 > uint64(maxBytes) {
			return nil, stream.ErrLimitExceeded
		}
		file, err := entry.Open()
		if err != nil {
			return nil, err
		}
		body, readErr := readBounded(file, maxBytes)
		_ = file.Close()
		return body, readErr
	}
	return nil, fmt.Errorf("archive entry %q is missing", name)
}

func archiveRecord(payload []byte) (stream.Record, error) {
	var record stream.Record
	if err := json.Unmarshal(payload, &record); err != nil {
		return stream.Record{}, err
	}
	if record.ID == "" || record.Title == "" {
		return stream.Record{}, errors.New("item payload must contain id and title")
	}
	return record, nil
}

func xmlText(document []byte) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(document))
	var builder strings.Builder
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return strings.TrimSpace(builder.String()), nil
		}
		if err != nil {
			return "", err
		}
		if character, ok := token.(xml.CharData); ok {
			text := strings.TrimSpace(string(character))
			if text != "" {
				if builder.Len() > 0 {
					builder.WriteByte(' ')
				}
				builder.WriteString(text)
			}
		}
	}
}

var pdfString = regexp.MustCompile(`\(([^()]*)\)\s*Tj`)

func pdfText(body []byte) string {
	matches := pdfString.FindAllSubmatch(body, -1)
	parts := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) == 2 {
			parts = append(parts, string(match[1]))
		}
	}
	return strings.Join(parts, " ")
}
