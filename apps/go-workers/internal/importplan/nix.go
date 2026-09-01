package importplan

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

const (
	nixArchiveFormat  = "nix-archive"
	nixArchiveVersion = 1
	nixSchemaMinimum  = 1
	nixSchemaMaximum  = 2
)

var archiveIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type nixManifest struct {
	Format              string             `json:"format"`
	FormatVersion       int                `json:"formatVersion"`
	SchemaVersion       int                `json:"schemaVersion"`
	Profile             json.RawMessage    `json:"profile,omitempty"`
	ExportedAt          string             `json:"exportedAt"`
	Root                string             `json:"root"`
	RootEffectiveSchema *nixSchemaSnapshot `json:"rootEffectiveSchema"`
	IncludesDeleted     bool               `json:"includesDeleted"`
	Items               []nixManifestItem  `json:"items"`
	Omitted             []nixOmission      `json:"omitted"`
	Loss                []nixLoss          `json:"loss"`
}

type nixManifestItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Sequence string  `json:"seq"`
	Title    string  `json:"title"`
	Type     string  `json:"type"`
}

type nixOmission struct {
	ID       *string `json:"id"`
	ParentID string  `json:"parentId"`
	Reason   string  `json:"reason"`
	Detail   string  `json:"detail"`
}

type nixLoss struct {
	ItemID string `json:"itemId"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type nixSchemaSnapshot struct {
	Properties json.RawMessage `json:"properties"`
	Declared   json.RawMessage `json:"declared"`
	Inherit    bool            `json:"inherit"`
}

type nixBundle struct {
	ID                string             `json:"id"`
	ParentID          *string            `json:"parentId"`
	WorkspaceID       string             `json:"workspaceId"`
	Type              string             `json:"type"`
	Title             string             `json:"title"`
	Sequence          string             `json:"seq"`
	LifecycleState    string             `json:"lifecycleState"`
	CreatedAt         string             `json:"createdAt"`
	UpdatedAt         string             `json:"updatedAt"`
	Properties        json.RawMessage    `json:"properties"`
	Schema            *nixSchemaSnapshot `json:"schema"`
	Views             json.RawMessage    `json:"views"`
	ViewRows          json.RawMessage    `json:"viewRows"`
	ViewRowsTruncated bool               `json:"viewRowsTruncated"`
	Body              json.RawMessage    `json:"body"`
}

func parseNix(source Source, limits Limits) (Plan, error) {
	archive, err := openArchive(source, limits)
	if err != nil {
		return Plan{}, fmt.Errorf("open Nix archive: %w", err)
	}
	defer archive.Close()
	if len(archive.File) == 0 || archive.File[0].Name != "manifest.json" {
		return Plan{}, errors.New("the first Nix archive entry must be manifest.json")
	}

	manifestBody, err := readEntry(archive, "manifest.json", limits.MaxEntryBytes)
	if err != nil {
		return Plan{}, err
	}
	var manifest nixManifest
	if err := decodeStrictJSON(manifestBody, &manifest); err != nil {
		return Plan{}, fmt.Errorf("decode Nix manifest: %w", err)
	}
	if err := validateNixManifest(manifest, limits); err != nil {
		return Plan{}, err
	}
	if len(archive.File) != len(manifest.Items)+1 {
		return Plan{}, errors.New("the Nix archive contains unlisted or missing entries")
	}

	bundles := make(map[string]nixBundle, len(manifest.Items))
	seenEntries := map[string]bool{"manifest.json": true}
	for _, entry := range archive.File[1:] {
		if seenEntries[entry.Name] {
			return Plan{}, fmt.Errorf("the Nix archive contains duplicate entry %q", entry.Name)
		}
		seenEntries[entry.Name] = true
		id, ok := nixItemIDFromEntry(entry.Name)
		if !ok {
			return Plan{}, fmt.Errorf("the Nix archive entry %q is not supported", entry.Name)
		}
		body, readErr := readEntry(archive, entry.Name, limits.MaxEntryBytes)
		if readErr != nil {
			return Plan{}, readErr
		}
		var bundle nixBundle
		if decodeErr := decodeStrictJSON(body, &bundle); decodeErr != nil {
			return Plan{}, fmt.Errorf("decode Nix item %s: %w", id, decodeErr)
		}
		if bundle.ID != id || bundles[id].ID != "" {
			return Plan{}, fmt.Errorf("the Nix archive contains a duplicate or mismatched item %s", id)
		}
		bundles[id] = bundle
	}

	items := make([]Item, 0, len(manifest.Items))
	orders := make(map[string]int)
	depths := make(map[string]int, len(manifest.Items))
	seen := make(map[string]bool, len(manifest.Items))
	for _, entry := range manifest.Items {
		bundle, ok := bundles[entry.ID]
		if !ok {
			return Plan{}, fmt.Errorf("the Nix archive has no payload for item %s", entry.ID)
		}
		if seen[entry.ID] || bundle.ParentID == nil != (entry.ParentID == nil) || !sameOptionalString(bundle.ParentID, entry.ParentID) ||
			bundle.Sequence != entry.Sequence || bundle.Type != entry.Type || bundle.Title != entry.Title {
			return Plan{}, fmt.Errorf("the Nix payload for item %s disagrees with its manifest", entry.ID)
		}
		if entry.ID == manifest.Root {
			if entry.ParentID != nil {
				return Plan{}, errors.New("the Nix archive root has a parent")
			}
		} else if entry.ParentID == nil || !seen[*entry.ParentID] {
			return Plan{}, fmt.Errorf("Nix item %s does not follow its parent", entry.ID)
		}
		depth := 0
		if entry.ParentID != nil {
			depth = depths[*entry.ParentID] + 1
		}
		if depth > limits.MaxDepth {
			return Plan{}, errors.New("the Nix archive tree is too deep")
		}
		depths[entry.ID] = depth
		seen[entry.ID] = true

		lifecycle := bundle.LifecycleState
		if lifecycle != "active" && lifecycle != "deleted" {
			return Plan{}, fmt.Errorf("Nix item %s has an unsupported lifecycle state", entry.ID)
		}
		if err := validateNixBundle(bundle, manifest.SchemaVersion, limits); err != nil {
			return Plan{}, fmt.Errorf("Nix item %s: %w", entry.ID, err)
		}
		parentKey := "$root"
		if entry.ParentID != nil {
			parentKey = *entry.ParentID
		}
		order := orders[parentKey]
		orders[parentKey] = order + 1
		planItem := Item{
			SourceID: entry.ID, ParentSourceID: entry.ParentID, Order: order,
			Title: bundle.Title, ItemType: bundle.Type, Properties: cloneJSON(bundle.Properties),
			Schema: importNixSchema(entry.ID == manifest.Root, manifest.RootEffectiveSchema, bundle.Schema),
			Views:  cloneNullableJSON(bundle.Views), FinalLifecycleState: lifecycle,
		}
		if !isJSONNull(bundle.Body) {
			planItem.Body = &Body{Encoding: "archive", Archive: cloneJSON(bundle.Body)}
		}
		items = append(items, planItem)
	}
	if !seen[manifest.Root] {
		return Plan{}, errors.New("the Nix archive root is not listed")
	}

	loss := make([]string, 0, len(manifest.Loss))
	for _, value := range manifest.Loss {
		loss = append(loss, value.Kind+": "+value.Detail)
	}
	omissions := make([]string, 0, len(manifest.Omitted))
	for _, value := range manifest.Omitted {
		omissions = append(omissions, value.Reason+": "+value.Detail)
	}
	return Plan{
		Version: Version, Format: "nix", Title: source.Title, SourceSHA256: source.SHA256,
		Items: items, Loss: loss, Omissions: omissions,
	}, nil
}

func validateNixManifest(manifest nixManifest, limits Limits) error {
	if manifest.Format != nixArchiveFormat || manifest.FormatVersion != nixArchiveVersion {
		return errors.New("the Nix archive format or version is unsupported")
	}
	if manifest.SchemaVersion < nixSchemaMinimum || manifest.SchemaVersion > nixSchemaMaximum {
		return errors.New("the Nix archive editor schema is unsupported")
	}
	if !validArchiveID(manifest.Root) || manifest.ExportedAt == "" || len(manifest.Items) == 0 || len(manifest.Items) > limits.MaxItems {
		return errors.New("the Nix archive manifest is incomplete or exceeds the item limit")
	}
	if len(manifest.Omitted) > limits.MaxItems || len(manifest.Loss) > limits.MaxItems {
		return errors.New("the Nix archive report exceeds the item limit")
	}
	for _, entry := range manifest.Items {
		if !validArchiveID(entry.ID) || (entry.ParentID != nil && !validArchiveID(*entry.ParentID)) ||
			!validIntegerString(entry.Sequence) || len(entry.Title) > 500 || strings.TrimSpace(entry.Type) == "" || len(entry.Type) > 64 {
			return errors.New("the Nix archive manifest contains an invalid item")
		}
	}
	for _, value := range manifest.Omitted {
		if !validArchiveID(value.ParentID) || (value.ID != nil && !validArchiveID(*value.ID)) ||
			(value.Reason != "not-readable" && value.Reason != "soft-deleted" && value.Reason != "limit-reached") || len(value.Detail) > 1000 {
			return errors.New("the Nix archive manifest contains an invalid omission")
		}
	}
	for _, value := range manifest.Loss {
		if !validArchiveID(value.ItemID) || strings.TrimSpace(value.Kind) == "" || len(value.Kind) > 100 || len(value.Detail) > 1000 {
			return errors.New("the Nix archive manifest contains an invalid loss entry")
		}
	}
	return nil
}

func validateNixBundle(bundle nixBundle, manifestSchema int, limits Limits) error {
	if !validArchiveID(bundle.ID) || !validArchiveID(bundle.WorkspaceID) ||
		(bundle.ParentID != nil && !validArchiveID(*bundle.ParentID)) || !validIntegerString(bundle.Sequence) ||
		strings.TrimSpace(bundle.Type) == "" || len(bundle.Type) > 64 || len(bundle.Title) > 500 ||
		!isJSONObject(bundle.Properties) || !isJSONArray(bundle.ViewRows) || len(bundle.Body) > int(limits.MaxBodyBytes) {
		return errors.New("the item envelope is invalid")
	}
	if bundle.Schema != nil && (!isJSONArray(bundle.Schema.Properties) || !isJSONArray(bundle.Schema.Declared)) {
		return errors.New("the property schema is invalid")
	}
	if !isJSONNull(bundle.Views) && !isJSONObject(bundle.Views) {
		return errors.New("the item views are invalid")
	}
	if !isJSONNull(bundle.Body) {
		var body struct {
			SchemaVersion int             `json:"schemaVersion"`
			ProseMirror   json.RawMessage `json:"prosemirror"`
			Sheet         json.RawMessage `json:"sheet"`
			Canvas        json.RawMessage `json:"canvas"`
		}
		if err := decodeStrictJSON(bundle.Body, &body); err != nil || body.SchemaVersion < 1 {
			return errors.New("the item body is invalid")
		}
		expected := body.ProseMirror
		if bundle.Type == "canvas" {
			expected = body.Canvas
		} else if bundle.Type == "sheet" || bundle.Type == "spreadsheet" {
			expected = body.Sheet
		}
		if !isJSONObject(expected) || (bundle.Type != "sheet" && bundle.Type != "spreadsheet" && body.SchemaVersion > manifestSchema) {
			return errors.New("the item body does not match its type or schema")
		}
	}
	return nil
}

func importNixSchema(root bool, effective, declared *nixSchemaSnapshot) json.RawMessage {
	selected := declared
	if root && effective != nil {
		selected = effective
	}
	if selected == nil {
		return nil
	}
	properties := selected.Declared
	inherit := selected.Inherit
	if root {
		properties = selected.Properties
		inherit = false
	}
	body, _ := json.Marshal(struct {
		Properties json.RawMessage `json:"properties"`
		Inherit    bool            `json:"inherit"`
	}{Properties: cloneJSON(properties), Inherit: inherit})
	return body
}

func decodeStrictJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}

func nixItemIDFromEntry(name string) (string, bool) {
	if !strings.HasPrefix(name, "items/") || !strings.HasSuffix(name, ".json") {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(name, "items/"), ".json")
	return id, validArchiveID(id)
}

func validArchiveID(value string) bool { return archiveIDPattern.MatchString(value) }

func validIntegerString(value string) bool {
	if value == "" {
		return false
	}
	_, err := strconv.ParseInt(value, 10, 64)
	return err == nil
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func isJSONNull(value json.RawMessage) bool {
	return len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func isJSONObject(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' && json.Valid(trimmed)
}

func isJSONArray(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) >= 2 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' && json.Valid(trimmed)
}

func cloneJSON(value json.RawMessage) json.RawMessage { return append(json.RawMessage(nil), value...) }

func cloneNullableJSON(value json.RawMessage) json.RawMessage {
	if isJSONNull(value) {
		return nil
	}
	return cloneJSON(value)
}
