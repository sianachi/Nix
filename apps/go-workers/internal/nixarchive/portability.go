package nixarchive

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrFileBytesUnsupported means archive v1 was refused because completing it would lose file
// bytes. Callers may surface this as a permanent unsupported-input failure rather than retrying it.
var ErrFileBytesUnsupported = errors.New("Nix archive v1 has no file-byte entry format")

func validateManifestFilePortability(manifest Manifest) error {
	fileItems := make(map[string]struct{})
	for _, item := range manifest.Items {
		if item.Type == "file" {
			fileItems[item.ID] = struct{}{}
		}
	}
	if len(manifest.Raw) > 0 {
		var wire struct {
			Items []ManifestItem `json:"items"`
		}
		if err := json.Unmarshal(manifest.Raw, &wire); err != nil {
			return fmt.Errorf("archive source JSON is invalid: %w", err)
		}
		for _, item := range wire.Items {
			if item.Type == "file" {
				fileItems[item.ID] = struct{}{}
			}
		}
	}
	if manifest.FormatVersion == FormatVersion {
		if item, ok := firstFileItem(manifest.Items); ok {
			return fileItemUnsupported(item.ID)
		}
		return nil
	}
	for _, entry := range manifest.Files {
		if _, ok := fileItems[entry.ItemID]; !ok {
			return fmt.Errorf("Nix archive file entry refers to unknown file item %s", entry.ItemID)
		}
	}
	return nil
}

func validateBundleFilePortability(bundle Bundle, manifest Manifest) error {
	var rawBody json.RawMessage
	if len(bundle.Raw) > 0 {
		// Raw is the representation the writer preserves. Inspect it as well as decoded fields so
		// callers cannot attach harmless typed fields to source JSON with hidden file references.
		var wire struct {
			ID   string          `json:"id"`
			Type string          `json:"type"`
			Body json.RawMessage `json:"body"`
		}
		if err := json.Unmarshal(bundle.Raw, &wire); err != nil {
			return fmt.Errorf("archive source JSON is invalid: %w", err)
		}
		if wire.ID != bundle.ID || wire.Type != bundle.Type {
			return fmt.Errorf("archive bundle source does not match its validated descriptor")
		}
		if wire.Type == "file" && manifest.FormatVersion == FormatVersion {
			return fileItemUnsupported(firstNonEmpty(wire.ID, bundle.ID))
		}
		rawBody = wire.Body
	}
	if bundle.Type == "file" && manifest.FormatVersion == FormatVersion {
		return fileItemUnsupported(bundle.ID)
	}
	if manifest.FormatVersion == FormatVersion {
		for _, body := range []json.RawMessage{bundle.Body, rawBody} {
			found, err := bodyHasDurableFileReference(body)
			if err != nil {
				return fmt.Errorf("archive bundle %s body is invalid: %w", bundle.ID, err)
			}
			if found {
				return fileReferenceUnsupported(bundle.ID)
			}
		}
		return nil
	}

	fileItems := make(map[string]struct{})
	for _, entry := range manifest.Files {
		fileItems[entry.ItemID] = struct{}{}
	}
	for _, body := range []json.RawMessage{bundle.Body, rawBody} {
		references, err := durableFileReferences(body)
		if err != nil {
			return fmt.Errorf("archive bundle %s body is invalid: %w", bundle.ID, err)
		}
		for _, itemID := range references {
			if _, ok := fileItems[itemID]; !ok {
				return fmt.Errorf("archive bundle %s refers to file item %s without included file bytes", bundle.ID, itemID)
			}
		}
	}
	return nil
}

func firstFileItem(items []ManifestItem) (ManifestItem, bool) {
	for _, item := range items {
		if item.Type == "file" {
			return item, true
		}
	}
	return ManifestItem{}, false
}

func fileItemUnsupported(itemID string) error {
	return fmt.Errorf(
		"%w: cannot export file item %s losslessly",
		ErrFileBytesUnsupported,
		itemID,
	)
}

func fileReferenceUnsupported(itemID string) error {
	return fmt.Errorf(
		"%w: cannot export item %s losslessly because its body contains a durable file reference",
		ErrFileBytesUnsupported,
		itemID,
	)
}

func bodyHasDurableFileReference(body json.RawMessage) (bool, error) {
	references, err := durableFileReferences(body)
	return len(references) > 0, err
}

func durableFileReferences(body json.RawMessage) ([]string, error) {
	if len(bytes.TrimSpace(body)) == 0 || bytes.Equal(bytes.TrimSpace(body), []byte("null")) {
		return nil, nil
	}

	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, nil
	}
	var references []string
	if document, exists := root["prosemirror"]; exists {
		references = append(references, proseDurableFileReferences(document)...)
	}
	if scene, exists := root["canvas"]; exists {
		references = append(references, canvasDurableFileReferences(scene)...)
	}
	return references, nil
}

func proseDurableFileReferences(document any) []string {
	var references []string
	pending := []any{document}
	for len(pending) > 0 {
		last := len(pending) - 1
		value := pending[last]
		pending = pending[:last]
		node, ok := value.(map[string]any)
		if !ok {
			continue
		}

		if node["type"] == "image" {
			attributes, _ := node["attrs"].(map[string]any)
			fileItemID, _ := attributes["fileItemId"].(string)
			source, _ := attributes["src"].(string)
			if fileItemID != "" {
				references = append(references, fileItemID)
			} else if strings.HasPrefix(source, "nix-file:") {
				references = append(references, strings.TrimPrefix(source, "nix-file:"))
			}
		}

		if content, ok := node["content"].([]any); ok {
			pending = append(pending, content...)
		}
	}
	return references
}

func canvasDurableFileReferences(scene any) []string {
	root, ok := scene.(map[string]any)
	if !ok {
		return nil
	}

	var elements []any
	switch value := root["elements"].(type) {
	case []any:
		elements = value
	case map[string]any:
		elements = make([]any, 0, len(value))
		for _, element := range value {
			elements = append(elements, element)
		}
	}

	var references []string
	for _, value := range elements {
		element, ok := value.(map[string]any)
		if !ok {
			continue
		}
		customData, _ := element["customData"].(map[string]any)
		marker, _ := customData["nix"].(map[string]any)
		itemID, _ := marker["itemId"].(string)
		if marker["kind"] == "file" && itemID != "" {
			references = append(references, itemID)
		}
		imageItemID, _ := element["imageItemId"].(string)
		if element["type"] == "image" && imageItemID != "" {
			references = append(references, imageItemID)
		}
	}
	return references
}

func firstNonEmpty(first, fallback string) string {
	if first != "" {
		return first
	}
	return fallback
}
