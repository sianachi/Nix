package docsbrowser

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const maxBytes = 64 << 20
const maxEntryBytes = 8 << 20

type descriptor struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	ItemCount int    `json:"itemCount"`
}
type record struct {
	Slug         string `json:"slug"`
	SourcePath   string `json:"sourcePath"`
	Title        string `json:"title"`
	ItemID       string `json:"itemId"`
	Archive      string `json:"archive"`
	SourceItemID string `json:"sourceItemId"`
	SourceSHA256 string `json:"sourceSha256"`
	SourceBytes  int    `json:"sourceBytes"`
}
type catalog struct {
	Archives   []descriptor `json:"archives"`
	Pages      []record     `json:"pages"`
	Documents  []record     `json:"documents"`
	Containers []record     `json:"containers"`
}
type library struct {
	Catalog  catalog
	Archives map[string][]nixarchive.Bundle
}

func checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func boundedRead(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("documentation exceeds its size limit")
	}
	return data, err
}

func readArchive(root string, desc descriptor) ([]nixarchive.Bundle, error) {
	if !filepath.IsLocal(desc.Path) {
		return nil, errors.New("archive path must stay inside the repository")
	}
	file, err := os.Open(filepath.Join(root, desc.Path))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, errors.New("documentation archive exceeds its size limit")
	}
	data, err := boundedRead(file, maxBytes)
	if err != nil {
		return nil, err
	}
	if checksum(data) != desc.SHA256 {
		return nil, errors.New("archive checksum mismatch")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	if len(archive.File) == 0 || len(archive.File) > 10001 || archive.File[0].Name != "manifest.json" {
		return nil, errors.New("missing first manifest or too many archive entries")
	}
	entries := make(map[string]*zip.File)
	var total uint64
	for _, entry := range archive.File {
		if _, exists := entries[entry.Name]; exists {
			return nil, errors.New("duplicate archive entry")
		}
		if entry.UncompressedSize64 > maxEntryBytes {
			return nil, errors.New("documentation entry exceeds its size limit")
		}
		total += entry.UncompressedSize64
		if total > maxBytes {
			return nil, errors.New("documentation archive exceeds its expanded size limit")
		}
		entries[entry.Name] = entry
	}
	readJSON := func(name string, value any) error {
		entry := entries[name]
		if entry == nil {
			return fmt.Errorf("missing archive entry %s", name)
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		defer reader.Close()
		data, err := boundedRead(reader, maxEntryBytes)
		if err != nil {
			return err
		}
		return json.Unmarshal(data, value)
	}
	var manifest nixarchive.Manifest
	if err := readJSON("manifest.json", &manifest); err != nil {
		return nil, err
	}
	if err := nixarchive.ValidateManifest(manifest, 10000); err != nil {
		return nil, err
	}
	if len(manifest.Files) != 0 || len(manifest.Loss) != 0 || len(manifest.Omitted) != 0 {
		return nil, errors.New("documentation must be prose-only without loss or omitted content")
	}
	if len(manifest.Items) != desc.ItemCount || len(entries) != len(manifest.Items)+1 {
		return nil, errors.New("documentation archive item set is incomplete")
	}
	bundles := make([]nixarchive.Bundle, 0, len(manifest.Items))
	seen := make(map[string]bool)
	roots := 0
	for _, item := range manifest.Items {
		var bundle nixarchive.Bundle
		if err := readJSON("items/"+item.ID+".json", &bundle); err != nil {
			return nil, err
		}
		if bundle.ID != item.ID || !reflect.DeepEqual(bundle.ParentID, item.ParentID) || bundle.Seq != item.Seq || bundle.Title != item.Title || bundle.Type != item.Type {
			return nil, errors.New("item and manifest disagree")
		}
		if bundle.ParentID == nil {
			roots++
			if bundle.ID != manifest.Root {
				return nil, errors.New("invalid documentation root")
			}
		} else if !seen[*bundle.ParentID] {
			return nil, errors.New("invalid documentation parent order")
		}
		seen[bundle.ID] = true
		bundles = append(bundles, bundle)
	}
	if roots != 1 {
		return nil, errors.New("invalid documentation root count")
	}
	return bundles, nil
}

func findRoot() (string, error) {
	path, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if info, err := os.Stat(filepath.Join(path, "docs/nix/catalog.json")); err == nil && info.Mode().IsRegular() {
			return path, nil
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", errors.New("cannot find docs/nix/catalog.json; run from the Nix repository")
		}
		path = parent
	}
}

func (c catalog) records() []record {
	rows := append([]record{}, c.Pages...)
	rows = append(rows, c.Documents...)
	return append(rows, c.Containers...)
}

func load(root string) (*library, error) {
	file, err := os.Open(filepath.Join(root, "docs/nix/catalog.json"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := boundedRead(file, maxEntryBytes)
	if err != nil {
		return nil, err
	}
	lib := &library{Archives: make(map[string][]nixarchive.Bundle)}
	if err := json.Unmarshal(data, &lib.Catalog); err != nil {
		return nil, err
	}
	if len(lib.Catalog.Archives) == 0 || len(lib.Catalog.Archives) > 100 {
		return nil, errors.New("documentation archive count is outside limits")
	}
	for _, desc := range lib.Catalog.Archives {
		if _, exists := lib.Archives[desc.Path]; exists {
			return nil, errors.New("duplicate catalog archive")
		}
		bundles, err := readArchive(root, desc)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", desc.Path, err)
		}
		lib.Archives[desc.Path] = bundles
	}
	for _, row := range lib.Catalog.records() {
		if _, err := lib.bundle(row.Archive, row.ItemID); err != nil {
			return nil, err
		}
		if row.SourceItemID != "" {
			bundle, err := lib.bundle(row.Archive, row.SourceItemID)
			if err != nil {
				return nil, err
			}
			source, err := originalSource(bundle)
			if err != nil {
				return nil, err
			}
			if len(source) != row.SourceBytes || checksum([]byte(source)) != row.SourceSHA256 {
				return nil, fmt.Errorf("source preservation failed: %s", row.SourcePath)
			}
		}
	}
	return lib, nil
}

func (lib *library) bundle(archive, id string) (nixarchive.Bundle, error) {
	for _, bundle := range lib.Archives[archive] {
		if bundle.ID == id {
			return bundle, nil
		}
	}
	return nixarchive.Bundle{}, fmt.Errorf("catalog points to absent note %s", id)
}

func (lib *library) selectRecord(query string) (record, error) {
	var exact, matches []record
	for _, row := range lib.Catalog.records() {
		if query == row.Slug || query == row.SourcePath || query == row.ItemID {
			exact = append(exact, row)
		}
		if strings.Contains(strings.ToLower(row.Title), strings.ToLower(query)) {
			matches = append(matches, row)
		}
	}
	if len(exact) != 0 {
		matches = exact
	}
	if len(matches) != 1 {
		return record{}, fmt.Errorf("expected one match for %q; found %d; use list to select a path or slug", query, len(matches))
	}
	return matches[0], nil
}

// Run keeps the offline commands usable in pipes; an interactive terminal opens the TUI.
func Run(args []string, input *os.File, output io.Writer) error {
	command, query := "tui", ""
	if len(args) > 2 {
		return errors.New("usage: nix-docs [tui [query]|list|read query|source original-path|check]")
	}
	if len(args) > 0 {
		command = args[0]
	}
	if len(args) > 1 {
		query = args[1]
	}
	if command == "--help" || command == "-h" {
		_, err := fmt.Fprintln(output, "Usage: nix-docs [tui [query]|list|read query|source original-path|check]\nNo command opens the offline documentation TUI.")
		return err
	}
	if command != "tui" && command != "list" && command != "read" && command != "source" && command != "check" {
		return fmt.Errorf("unknown command %q", command)
	}
	if (command == "read" || command == "source") && query == "" {
		return errors.New("read and source require a page slug, document path or title")
	}
	if (command == "list" || command == "check") && query != "" {
		return fmt.Errorf("%s does not accept a query", command)
	}
	root, err := findRoot()
	if err != nil {
		return err
	}
	lib, err := load(root)
	if err != nil {
		return err
	}
	switch command {
	case "list":
		for _, row := range lib.Catalog.records() {
			name := row.Slug
			if name == "" {
				name = row.SourcePath
			}
			if name == "" {
				name = row.ItemID
			}
			if _, err := fmt.Fprintf(output, "%s\t%s\n", name, row.Title); err != nil {
				return err
			}
		}
		return nil
	case "check":
		_, err := fmt.Fprintf(output, "Verified %d native archives, %d guide pages and %d exact source documents.\n", len(lib.Archives), len(lib.Catalog.Pages), len(lib.Catalog.Documents))
		return err
	case "read", "source":
		row, err := lib.selectRecord(query)
		if err != nil {
			return err
		}
		id := row.ItemID
		if command == "source" {
			if row.SourceItemID == "" {
				return errors.New("this native guide has no original Markdown source")
			}
			id = row.SourceItemID
		}
		bundle, err := lib.bundle(row.Archive, id)
		if err != nil {
			return err
		}
		var value string
		if command == "source" {
			value, err = originalSource(bundle)
		} else {
			value, _, err = renderBundle(bundle, false)
		}
		if err != nil {
			return err
		}
		_, err = io.WriteString(output, value)
		return err
	default:
		return runTUI(lib, query, input, output)
	}
}
