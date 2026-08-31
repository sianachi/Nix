package nixarchive

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

// Write writes a validated, lossless archive while retaining only the current bundle in memory.
// The zip central directory is emitted by archive/zip at Close; payloads are written entry by entry.
func Write(output io.Writer, manifest Manifest, bundles []Bundle, maxBytes int64) error {
	if err := ValidateManifest(manifest, len(manifest.Items)); err != nil {
		return err
	}
	if len(bundles) != len(manifest.Items) {
		return fmt.Errorf("archive bundle count does not match manifest")
	}
	limited := &limitedWriter{writer: output, remaining: maxBytes}
	archive := zip.NewWriter(limited)
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := writeEntry(archive, "manifest.json", manifestBytes); err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(bundles))
	for _, bundle := range bundles {
		if !safeID.MatchString(bundle.ID) {
			return fmt.Errorf("unsafe bundle identifier")
		}
		if _, ok := seen[bundle.ID]; ok {
			return fmt.Errorf("duplicate bundle %s", bundle.ID)
		}
		seen[bundle.ID] = struct{}{}
		payload, err := json.Marshal(bundle)
		if err != nil {
			return err
		}
		if err := writeEntry(archive, "items/"+bundle.ID+".json", payload); err != nil {
			return err
		}
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
	entry, err := archive.Create(name)
	if err != nil {
		return err
	}
	_, err = entry.Write(payload)
	return err
}
