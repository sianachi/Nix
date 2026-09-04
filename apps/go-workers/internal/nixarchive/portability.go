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
	if item, ok := firstFileItem(manifest.Items); ok {
		return fileItemUnsupported(item.ID)
	}
	if len(manifest.Raw) == 0 {
		return nil
	}

	var wire struct {
		Items []ManifestItem `json:"items"`
	}
	if err := json.Unmarshal(manifest.Raw, &wire); err != nil {
		return fmt.Errorf("archive source JSON is invalid: %w", err)
	}
	if item, ok := firstFileItem(wire.Items); ok {
		return fileItemUnsupported(item.ID)
	}
	return nil
}

func validateBundleFilePortability(bundle Bundle) error {
	if bundle.Type == "file" {
		return fileItemUnsupported(bundle.ID)
	}
	if found, err := bodyHasDurableFileReference(bundle.Body); err != nil {
		return fmt.Errorf("archive bundle %s body is invalid: %w", bundle.ID, err)
	} else if found {
		return fileReferenceUnsupported(bundle.ID)
	}
	if len(bundle.Raw) == 0 {
		return nil
	}

	// Raw is the representation the writer preserves. Inspect it as well as the decoded fields so a
	// caller cannot attach an innocuous struct to source JSON that actually carries a file.
	var wire struct {
		ID   string          `json:"id"`
		Type string          `json:"type"`
		Body json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(bundle.Raw, &wire); err != nil {
		return fmt.Errorf("archive source JSON is invalid: %w", err)
	}
	if wire.Type == "file" {
		return fileItemUnsupported(firstNonEmpty(wire.ID, bundle.ID))
	}
	if found, err := bodyHasDurableFileReference(wire.Body); err != nil {
		return fmt.Errorf("archive bundle %s body is invalid: %w", bundle.ID, err)
	} else if found {
		return fileReferenceUnsupported(firstNonEmpty(wire.ID, bundle.ID))
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
	if len(bytes.TrimSpace(body)) == 0 || bytes.Equal(bytes.TrimSpace(body), []byte("null")) {
		return false, nil
	}

	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return false, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return false, nil
	}
	if document, exists := root["prosemirror"]; exists {
		return proseHasDurableFileReference(document), nil
	}
	if scene, exists := root["canvas"]; exists {
		return canvasHasDurableFileReference(scene), nil
	}
	return false, nil
}

func proseHasDurableFileReference(document any) bool {
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
			if fileItemID != "" || strings.HasPrefix(source, "nix-file:") && len(source) > len("nix-file:") {
				return true
			}
		}

		if content, ok := node["content"].([]any); ok {
			pending = append(pending, content...)
		}
	}
	return false
}

func canvasHasDurableFileReference(scene any) bool {
	root, ok := scene.(map[string]any)
	if !ok {
		return false
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

	for _, value := range elements {
		element, ok := value.(map[string]any)
		if !ok {
			continue
		}
		customData, _ := element["customData"].(map[string]any)
		marker, _ := customData["nix"].(map[string]any)
		itemID, _ := marker["itemId"].(string)
		if marker["kind"] == "file" && itemID != "" {
			return true
		}
		imageItemID, _ := element["imageItemId"].(string)
		if element["type"] == "image" && imageItemID != "" {
			return true
		}
	}
	return false
}

func firstNonEmpty(first, fallback string) string {
	if first != "" {
		return first
	}
	return fallback
}
