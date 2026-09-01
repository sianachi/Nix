package importplan

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrUnsupportedFormat = errors.New("unsupported import format")
	ErrOCRUnavailable    = errors.New("PDF contains no extractable text; OCR is not available")
	ErrEncryptedPDF      = errors.New("encrypted PDF files are not supported")
)

func Parse(ctx context.Context, source Source, limits Limits) (Plan, error) {
	if err := validateSource(source, limits); err != nil {
		return Plan{}, err
	}
	format := normalizeFormat(source.Format)
	switch format {
	case "markdown":
		return parseTextSource(source, limits, true)
	case "txt":
		return parseTextSource(source, limits, false)
	case "pdf":
		return parsePDF(ctx, source, limits)
	case "docx":
		return parseDOCX(source, limits)
	case "nix":
		return parseNix(ctx, source, limits)
	default:
		return Plan{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, source.Format)
	}
}

func parseTextSource(source Source, limits Limits, markdown bool) (Plan, error) {
	body, err := readFileBounded(source.Path, limits.MaxBodyBytes)
	if err != nil {
		return Plan{}, err
	}
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	if binaryLookingText(body) || !utf8.Valid(body) {
		return Plan{}, errors.New("text input is not valid UTF-8 or appears to be binary")
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(string(body), "\r\n", "\n"), "\r", "\n")
	encoding := "plain_text"
	format := "txt"
	if markdown {
		encoding = "markdown"
		format = "markdown"
	}
	items := []Item{noteItem("root", nil, 0, source.Title, &Body{Encoding: encoding, Text: normalized})}
	if !markdown {
		items = append(items, originalItem(source, "text/plain", 0))
	}
	return Plan{
		Version: Version, Format: format, Title: source.Title, SourceSHA256: source.SHA256,
		Items: items, Loss: []string{}, Omissions: []string{},
	}, nil
}

func binaryLookingText(body []byte) bool {
	for _, value := range body {
		if value == 0x7f || value < 0x20 && value != '\t' && value != '\n' && value != '\r' {
			return true
		}
	}
	return false
}

func parsePDF(ctx context.Context, source Source, limits Limits) (Plan, error) {
	header, err := readFilePrefix(source.Path, 8)
	if err != nil {
		return Plan{}, err
	}
	if !bytes.HasPrefix(header, []byte("%PDF-")) {
		return Plan{}, errors.New("PDF input does not start with a PDF signature")
	}
	timeout := time.Duration(limits.PDFTimeoutSecs) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command, err := newPDFTextCommand(commandContext, source.Path, max(1, limits.PDFTimeoutSecs), 256<<20)
	if err != nil {
		return Plan{}, fmt.Errorf("pdftotext is unavailable: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return Plan{}, fmt.Errorf("start pdftotext: %w", err)
	}
	var stderr limitedBuffer
	stderr.limit = 8 << 10
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return Plan{}, fmt.Errorf("pdftotext is unavailable: %w", err)
	}
	output, readErr := readBounded(stdout, limits.MaxBodyBytes)
	if readErr != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return Plan{}, readErr
	}
	waitErr := command.Wait()
	if commandContext.Err() != nil {
		return Plan{}, errors.New("PDF extraction exceeded its time limit")
	}
	if waitErr != nil {
		detail := strings.TrimSpace(stderr.String())
		lower := strings.ToLower(detail)
		if strings.Contains(lower, "password") || strings.Contains(lower, "encrypted") {
			return Plan{}, ErrEncryptedPDF
		}
		if detail == "" {
			detail = waitErr.Error()
		}
		return Plan{}, fmt.Errorf("PDF extraction failed: %s", detail)
	}
	text := strings.TrimSpace(strings.ReplaceAll(string(output), "\f", "\n\n[Page break]\n\n"))
	if text == "" {
		return Plan{}, ErrOCRUnavailable
	}
	return Plan{
		Version: Version, Format: "pdf", Title: source.Title, SourceSHA256: source.SHA256,
		Items: []Item{
			noteItem("root", nil, 0, source.Title, &Body{Encoding: "plain_text", Text: text}),
			originalItem(source, "application/pdf", 0),
		},
		Loss:      []string{"PDF fonts, vector graphics, images, and exact page layout are not preserved."},
		Omissions: []string{},
	}, nil
}

func noteItem(sourceID string, parent *string, order int, title string, body *Body) Item {
	return Item{
		SourceID: sourceID, ParentSourceID: parent, Order: order, Title: title, ItemType: "note",
		FinalLifecycleState: "active", Body: body,
	}
}

func originalItem(source Source, mediaType string, order int) Item {
	parent := "root"
	return Item{
		SourceID: "original", ParentSourceID: &parent, Order: order, Title: source.FileName,
		ItemType: "file", FinalLifecycleState: "active",
		File: &File{
			SourceKind: "source", FileName: source.FileName, MediaType: mediaType,
			ByteLength: source.Bytes, SHA256: source.SHA256,
		},
	}
}

func validateSource(source Source, limits Limits) error {
	if source.Path == "" || source.Title == "" || source.FileName == "" || source.SHA256 == "" {
		return errors.New("source path, title, file name, and checksum are required")
	}
	if source.Bytes < 0 || source.Bytes > limits.MaxSourceBytes || limits.MaxItems <= 0 || limits.MaxBodyBytes <= 0 || limits.MaxEntryBytes <= 0 || limits.MaxPlanBytes <= 0 {
		return errors.New("source or import limits are invalid")
	}
	return nil
}

func normalizeFormat(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "md", "markdown":
		return "markdown"
	case "text", "txt":
		return "txt"
	case "pdf", "docx", "nix":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func readFileBounded(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return readBounded(file, maxBytes)
}

func readFilePrefix(path string, count int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, count))
}

func readBounded(source io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(source, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, errors.New("input exceeds the configured byte limit")
	}
	return body, nil
}

type limitedBuffer struct {
	value bytes.Buffer
	limit int
}

func (buffer *limitedBuffer) Write(value []byte) (int, error) {
	written := len(value)
	remaining := buffer.limit - buffer.value.Len()
	if remaining > 0 {
		_, _ = buffer.value.Write(value[:min(len(value), remaining)])
	}
	return written, nil
}

func (buffer *limitedBuffer) String() string { return buffer.value.String() }
