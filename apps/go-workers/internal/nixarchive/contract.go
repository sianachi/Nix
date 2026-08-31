package nixarchive

import (
	"encoding/json"
	"fmt"
	"regexp"
)

const (
	Format        = "nix-archive"
	FormatVersion = 1
)

type Manifest struct {
	Format              string          `json:"format"`
	FormatVersion       int             `json:"formatVersion"`
	SchemaVersion       int             `json:"schemaVersion"`
	ExportedAt          string          `json:"exportedAt"`
	Root                string          `json:"root"`
	RootEffectiveSchema json.RawMessage `json:"rootEffectiveSchema"`
	IncludesDeleted     bool            `json:"includesDeleted"`
	Items               []ManifestItem  `json:"items"`
	Omitted             []Omission      `json:"omitted"`
	Loss                []LossEntry     `json:"loss"`
}

type ManifestItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Seq      string  `json:"seq"`
	Title    string  `json:"title"`
	Type     string  `json:"type"`
}
type Omission struct {
	ID       *string `json:"id"`
	ParentID string  `json:"parentId"`
	Reason   string  `json:"reason"`
	Detail   string  `json:"detail"`
}
type LossEntry struct {
	ItemID string `json:"itemId"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type Bundle struct {
	ID                string            `json:"id"`
	ParentID          *string           `json:"parentId"`
	WorkspaceID       string            `json:"workspaceId"`
	Type              string            `json:"type"`
	Title             string            `json:"title"`
	Seq               string            `json:"seq"`
	LifecycleState    string            `json:"lifecycleState"`
	CreatedAt         string            `json:"createdAt"`
	UpdatedAt         string            `json:"updatedAt"`
	Properties        map[string]any    `json:"properties"`
	Schema            json.RawMessage   `json:"schema"`
	Views             json.RawMessage   `json:"views"`
	ViewRows          []json.RawMessage `json:"viewRows"`
	ViewRowsTruncated bool              `json:"viewRowsTruncated"`
	Body              json.RawMessage   `json:"body"`
}

var safeID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func ValidateManifest(manifest Manifest, maxItems int) error {
	if manifest.Format != Format || manifest.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported Nix archive format")
	}
	if manifest.Root == "" || !safeID.MatchString(manifest.Root) {
		return fmt.Errorf("manifest root is not a safe item identifier")
	}
	if len(manifest.Items) == 0 || len(manifest.Items) > maxItems {
		return fmt.Errorf("manifest item count is outside limits")
	}
	seen := make(map[string]struct{}, len(manifest.Items))
	for _, item := range manifest.Items {
		if !safeID.MatchString(item.ID) || item.Title == "" || item.Seq == "" {
			return fmt.Errorf("manifest contains an invalid item")
		}
		if _, ok := seen[item.ID]; ok {
			return fmt.Errorf("manifest contains duplicate item %s", item.ID)
		}
		seen[item.ID] = struct{}{}
	}
	if _, ok := seen[manifest.Root]; !ok {
		return fmt.Errorf("manifest root is not listed")
	}
	return nil
}
