package nixarchive

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// Write writes a validated, lossless archive while retaining only the current bundle in memory.
// The zip central directory is emitted by archive/zip at Close; payloads are written entry by entry.
func Write(output io.Writer, manifest Manifest, bundles []Bundle, maxBytes int64) error {
	index := 0
	return WriteStream(output, manifest, func() (Bundle, bool, error) {
		if index == len(bundles) {
			return Bundle{}, false, nil
		}
		bundle := bundles[index]
		index++
		return bundle, true, nil
	}, maxBytes)
}

// WriteStream writes one validated bundle at a time and never retains the workspace body set.
func WriteStream(output io.Writer, manifest Manifest, next func() (Bundle, bool, error), maxBytes int64) error {
	if err := ValidateManifest(manifest, len(manifest.Items)); err != nil {
		return err
	}
	if output == nil || next == nil || maxBytes <= 0 {
		return fmt.Errorf("archive writer configuration is invalid")
	}
	limited := &limitedWriter{writer: output, remaining: maxBytes}
	archive := zip.NewWriter(limited)
	manifestBytes, err := encoded(manifest.Raw, manifest)
	if err != nil {
		return err
	}
	if err := writeEntry(archive, "manifest.json", manifestBytes); err != nil {
		return err
	}
	for index, item := range manifest.Items {
		bundle, ok, err := next()
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("archive bundle count does not match manifest")
		}
		if !safeID.MatchString(bundle.ID) {
			return fmt.Errorf("unsafe bundle identifier")
		}
		if bundle.ID != item.ID || bundle.ID != manifest.Items[index].ID {
			return fmt.Errorf("archive bundle order does not match manifest")
		}
		payload, err := encoded(bundle.Raw, bundle)
		if err != nil {
			return err
		}
		if err := writeEntry(archive, "items/"+bundle.ID+".json", payload); err != nil {
			return err
		}
	}
	if _, ok, err := next(); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("archive bundle count does not match manifest")
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limited.err
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
	count, err := writer.writer.Write(value)
	writer.remaining -= int64(count)
	writer.err = err
	return count, err
}
func writeEntry(archive *zip.Writer, name string, payload []byte) error {
	if strings.Contains(name, "..") || strings.Contains(name, "\\") {
		return fmt.Errorf("unsafe archive path")
	}
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(payload)
	return err
}

func encoded(raw json.RawMessage, value any) ([]byte, error) {
	if len(raw) > 0 {
		if !json.Valid(raw) {
			return nil, fmt.Errorf("archive source JSON is invalid")
		}
		return raw, nil
	}
	return json.Marshal(value)
}
