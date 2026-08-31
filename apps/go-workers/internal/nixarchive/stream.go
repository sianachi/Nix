package nixarchive

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type StreamEnd struct {
	End   bool `json:"end"`
	Items int  `json:"items"`
}

func ReadBundleStream(reader io.Reader, limits stream.Limits) (Manifest, []Bundle, error) {
	if limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0 {
		return Manifest{}, nil, errors.New("bundle stream limits must be positive")
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, limits.MaxBytes+1))
	scanner.Buffer(make([]byte, min(limits.MaxLine, 64*1024)), limits.MaxLine)
	if !scanner.Scan() {
		return Manifest{}, nil, errors.New("bundle stream is empty")
	}
	seenBytes := int64(len(scanner.Bytes()) + 1)
	var manifest Manifest
	if err := json.Unmarshal(scanner.Bytes(), &manifest); err != nil {
		return Manifest{}, nil, fmt.Errorf("bundle stream manifest: %w", err)
	}
	if err := ValidateManifest(manifest, limits.MaxRecords); err != nil {
		return Manifest{}, nil, err
	}
	bundles := make([]Bundle, 0, len(manifest.Items))
	ended := false
	for scanner.Scan() {
		seenBytes += int64(len(scanner.Bytes()) + 1)
		if seenBytes > limits.MaxBytes {
			return Manifest{}, nil, stream.ErrLimitExceeded
		}
		var end StreamEnd
		if err := json.Unmarshal(scanner.Bytes(), &end); err == nil && end.End {
			if end.Items != len(bundles) || len(bundles) != len(manifest.Items) {
				return Manifest{}, nil, errors.New("bundle stream sentinel count does not match manifest")
			}
			ended = true
			break
		}
		if len(bundles) >= limits.MaxRecords {
			return Manifest{}, nil, stream.ErrLimitExceeded
		}
		var bundle Bundle
		if err := json.Unmarshal(scanner.Bytes(), &bundle); err != nil || bundle.ID == "" || bundle.Title == "" {
			return Manifest{}, nil, errors.New("bundle stream contains an invalid item")
		}
		if bundle.ID != manifest.Items[len(bundles)].ID {
			return Manifest{}, nil, errors.New("bundle stream order does not match manifest")
		}
		bundles = append(bundles, bundle)
	}
	if err := scanner.Err(); err != nil {
		return Manifest{}, nil, err
	}
	if !ended || scanner.Scan() {
		return Manifest{}, nil, errors.New("bundle stream is truncated or has data after its sentinel")
	}
	return manifest, bundles, nil
}
