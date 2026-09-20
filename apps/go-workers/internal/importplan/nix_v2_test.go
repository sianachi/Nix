package importplan

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const (
	v2RootID  = "11111111-1111-4111-8111-111111111111"
	v2FileID  = "22222222-2222-4222-8222-222222222222"
	v2OtherID = "44444444-4444-4444-8444-444444444444"
)

func TestGoImporterReadsSharedTypeScriptV2ArchiveFixture(t *testing.T) {
	path := "../../../../fixtures/nix-archive-v2-file.nix"
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	source := Source{
		Path: path, Format: "nix", Title: "Report", FileName: "report.nix", MediaType: "application/x-nix-template",
		Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:]),
	}
	plan, err := Parse(context.Background(), source, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 1 || plan.Items[0].ItemType != "file" || len(plan.FileVersions) != 2 || plan.FileVersions[1].Version != 2 || !plan.FileVersions[1].Current {
		t.Fatalf("shared TypeScript archive import plan = %#v", plan)
	}
}

func TestNixArchiveFilesStreamsDeclaredVersionEntries(t *testing.T) {
	path := "../../../../fixtures/nix-archive-v2-file.nix"
	files, err := OpenNixArchiveFiles(path, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	for version, expected := range []string{"%PDF-1.5\nold version", "%PDF-1.5\ncurrent version"} {
		reader, err := files.OpenVersion(v2RootID, version+1, int64(len(expected)))
		if err != nil {
			t.Fatal(err)
		}
		actual, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || string(actual) != expected {
			t.Fatalf("version %d bytes = %q, read error = %v, close error = %v", version+1, actual, readErr, closeErr)
		}
	}
	if _, err := files.OpenVersion(v2RootID, 3, 1); err == nil {
		t.Fatal("unlisted file version was found")
	}
}

func TestNixV2FileHistoryIsVerifiedAndPreservedInImportPlan(t *testing.T) {
	archiveSource, descriptors := nixV2Archive(t, true)
	plan, err := Parse(context.Background(), archiveSource, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 2 || len(plan.FileVersions) != 2 {
		t.Fatalf("plan item/file counts = %d/%d", len(plan.Items), len(plan.FileVersions))
	}
	if plan.FileVersions[0].Version != 1 || plan.FileVersions[0].Current || plan.FileVersions[1].Version != 2 || !plan.FileVersions[1].Current {
		t.Fatalf("file history = %#v", plan.FileVersions)
	}
	body, digest, err := Encode(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(body, digest, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.FileVersions) != len(descriptors) || decoded.FileVersions[1].SHA256 != descriptors[1].SHA256 {
		t.Fatalf("decoded file history = %#v", decoded.FileVersions)
	}
}

func TestNixV2RejectsUntrustedFileMetadataAndArchiveMembers(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(*nixarchive.FileVersionEntry, []byte) (string, []byte)
		wantError string
	}{
		{
			name: "digest mismatch",
			mutate: func(entry *nixarchive.FileVersionEntry, _ []byte) (string, []byte) {
				entry.SHA256 = strings.Repeat("a", 64)
				return nixFileVersionEntryName(entry.ItemID, entry.Version), nil
			},
			wantError: "SHA-256",
		},
		{
			name: "content mime mismatch",
			mutate: func(entry *nixarchive.FileVersionEntry, _ []byte) (string, []byte) {
				entry.MediaType = "application/pdf"
				entry.Previewable = true
				invalid := bytes.Repeat([]byte("x"), int(entry.ByteLength))
				digest := sha256.Sum256(invalid)
				entry.SHA256 = hex.EncodeToString(digest[:])
				return nixFileVersionEntryName(entry.ItemID, entry.Version), invalid
			},
			wantError: "inspected file metadata",
		},
		{
			name: "path traversal",
			mutate: func(entry *nixarchive.FileVersionEntry, _ []byte) (string, []byte) {
				return "files/../outside/1.bin", []byte("%PDF-1.5\n")
			},
			wantError: "unsafe or encrypted",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := pdfDescriptor(v2FileID, 1, true, []byte("%PDF-1.5\nfirst"))
			entryName, fileBytes := test.mutate(&descriptor, []byte("%PDF-1.5\nfirst"))
			if fileBytes == nil {
				fileBytes = []byte("%PDF-1.5\nfirst")
			}
			source := zipSource(t, "hostile.nix", "nix", nixV2ZipEntries(t, descriptor, entryName, fileBytes))
			if _, err := Parse(context.Background(), source, testLimits()); err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Parse() error = %v, want substring %q", err, test.wantError)
			}
		})
	}
}

func TestTemplateV2PreservesFileHistoryAndSharedInitializationFixture(t *testing.T) {
	archiveSource, descriptors := nixV2TemplateArchive(t)
	plan, err := ParseTemplate(context.Background(), archiveSource, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != len(descriptors) || plan.Profile.Initialization == nil || len(plan.Profile.Initialization.Inputs) != 1 {
		t.Fatalf("template profile/files = %#v / %#v", plan.Profile.Initialization, plan.Files)
	}
	body, digest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeTemplate(body, digest, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Files) != len(descriptors) || decoded.Profile.Initialization == nil || decoded.Profile.Initialization.Inputs[0].Key != "project_name" {
		t.Fatalf("decoded template metadata = %#v", decoded)
	}

	fixtureBytes, err := os.ReadFile("../../../../fixtures/template-initialization-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture TemplateInitialization
	if err := decodeStrictJSON(fixtureBytes, &fixture); err != nil {
		t.Fatalf("shared initialization fixture did not decode: %v", err)
	}
	if err := validateTemplateInitialization(&fixture); err != nil {
		t.Fatalf("shared initialization fixture did not validate: %v", err)
	}
}

func TestTemplateInitializationRejectsMissingRequiredAndIrrelevantRuleFields(t *testing.T) {
	for _, body := range []string{
		`{"version":1,"inputs":[{"key":"project_name","label":"Project","type":"text"}],"rules":[],"references":[]}`,
		`{"version":1,"inputs":[{"key":"project_name","label":"Project","type":"text","required":false}],"rules":[{"sourceId":"11111111-1111-4111-8111-111111111111","propertyKey":"name","kind":"clear","inputKey":"project_name"}],"references":[]}`,
		`{"version":1,"inputs":[{"key":"ProjectName","label":"Project","type":"text","required":false}],"rules":[],"references":[]}`,
	} {
		var fixture TemplateInitialization
		err := decodeStrictJSON([]byte(body), &fixture)
		if err == nil {
			err = validateTemplateInitialization(&fixture)
		}
		if err == nil {
			t.Fatalf("invalid initialization was accepted: %s", body)
		}
	}
}

func nixV2Archive(t *testing.T, twoVersions bool) (Source, []nixarchive.FileVersionEntry) {
	t.Helper()
	first := []byte("%PDF-1.5\nfirst version")
	second := []byte("%PDF-1.5\ncurrent version")
	descriptors := []nixarchive.FileVersionEntry{pdfDescriptor(v2FileID, 1, !twoVersions, first)}
	if twoVersions {
		descriptors = append(descriptors, pdfDescriptor(v2FileID, 2, true, second))
	}
	root := map[string]any{"id": v2RootID, "parentId": nil, "seq": "1", "title": "Root", "type": "note"}
	child := map[string]any{"id": v2FileID, "parentId": v2RootID, "seq": "2", "title": "Report", "type": "file"}
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 2, "schemaVersion": 3, "exportedAt": "2026-09-20T00:00:00Z",
		"root": v2RootID, "rootEffectiveSchema": nil, "includesDeleted": false,
		"items": []any{root, child}, "files": descriptors, "omitted": []any{}, "loss": []any{},
	}
	rootBundle := nixV2Bundle(v2RootID, nil, "1", "Root", "note", json.RawMessage(`{"schemaVersion":3,"prosemirror":{"type":"doc","content":[]}}`))
	childBundle := nixV2Bundle(v2FileID, stringRef(v2RootID), "2", "Report", "file", json.RawMessage("null"))
	entries := []zipFixture{{"manifest.json", mustJSON(t, manifest)}, {"items/" + v2RootID + ".json", mustJSON(t, rootBundle)}, {"items/" + v2FileID + ".json", mustJSON(t, childBundle)}}
	files := [][]byte{first}
	if twoVersions {
		files = append(files, second)
	}
	for index, descriptor := range descriptors {
		entries = append(entries, zipFixture{nixFileVersionEntryName(descriptor.ItemID, descriptor.Version), files[index]})
	}
	return zipSource(t, "files.nix", "nix", entries), descriptors
}

func nixV2TemplateArchive(t *testing.T) (Source, []nixarchive.FileVersionEntry) {
	t.Helper()
	data := []byte("%PDF-1.5\nportable template file")
	descriptor := pdfDescriptor(v2FileID, 1, true, data)
	profile := map[string]any{
		"kind": "template", "version": 1, "key": "team.project", "name": "Project",
		"description": "Portable template", "includeBody": true, "includeChildren": true,
		"initialization": map[string]any{
			"version":    1,
			"inputs":     []any{map[string]any{"key": "project_name", "label": "Project name", "type": "text", "required": true}},
			"rules":      []any{map[string]any{"sourceId": v2RootID, "propertyKey": "name", "kind": "input", "inputKey": "project_name"}},
			"references": []any{map[string]any{"sourceItemId": v2OtherID, "policy": "omit"}},
		},
	}
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 2, "schemaVersion": 3, "profile": profile,
		"exportedAt": "2026-09-20T00:00:00Z", "root": v2RootID, "rootEffectiveSchema": nil,
		"includesDeleted": false, "items": []any{
			map[string]any{"id": v2RootID, "parentId": nil, "seq": "1", "title": "Project", "type": "note"},
			map[string]any{"id": v2FileID, "parentId": v2RootID, "seq": "2", "title": "Report", "type": "file"},
		}, "files": []nixarchive.FileVersionEntry{descriptor}, "omitted": []any{}, "loss": []any{},
	}
	body := json.RawMessage(`{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"","fileItemId":"22222222-2222-4222-8222-222222222222","alt":"Report"}}]}}`)
	rootBundle := nixV2Bundle(v2RootID, nil, "1", "Project", "note", body)
	childBundle := nixV2Bundle(v2FileID, stringRef(v2RootID), "2", "Report", "file", json.RawMessage("null"))
	return zipSource(t, "template.nix", "nix", []zipFixture{
		{"manifest.json", mustJSON(t, manifest)},
		{"items/" + v2RootID + ".json", mustJSON(t, rootBundle)},
		{"items/" + v2FileID + ".json", mustJSON(t, childBundle)},
		{nixFileVersionEntryName(v2FileID, 1), data},
	}), []nixarchive.FileVersionEntry{descriptor}
}

func nixV2ZipEntries(t *testing.T, descriptor nixarchive.FileVersionEntry, path string, bytes []byte) []zipFixture {
	t.Helper()
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 2, "schemaVersion": 3, "exportedAt": "2026-09-20T00:00:00Z",
		"root": v2RootID, "rootEffectiveSchema": nil, "includesDeleted": false,
		"items": []any{
			map[string]any{"id": v2RootID, "parentId": nil, "seq": "1", "title": "Root", "type": "note"},
			map[string]any{"id": v2FileID, "parentId": v2RootID, "seq": "2", "title": "Report", "type": "file"},
		}, "files": []nixarchive.FileVersionEntry{descriptor}, "omitted": []any{}, "loss": []any{},
	}
	rootBundle := nixV2Bundle(v2RootID, nil, "1", "Root", "note", json.RawMessage(`{"schemaVersion":3,"prosemirror":{"type":"doc","content":[]}}`))
	childBundle := nixV2Bundle(v2FileID, stringRef(v2RootID), "2", "Report", "file", json.RawMessage("null"))
	return []zipFixture{
		{"manifest.json", mustJSON(t, manifest)},
		{"items/" + v2RootID + ".json", mustJSON(t, rootBundle)},
		{"items/" + v2FileID + ".json", mustJSON(t, childBundle)},
		{path, bytes},
	}
}

func nixV2Bundle(id string, parent *string, seq, title, itemType string, body json.RawMessage) nixBundle {
	return nixBundle{
		ID: id, ParentID: parent, WorkspaceID: "33333333-3333-4333-8333-333333333333", Type: itemType,
		Title: title, Sequence: seq, LifecycleState: "active", CreatedAt: "2026-09-20T00:00:00Z", UpdatedAt: "2026-09-20T00:00:00Z",
		Properties: json.RawMessage("{}"), Schema: nil, Views: json.RawMessage("null"), ViewRows: json.RawMessage("[]"), Body: body,
	}
}

func stringRef(value string) *string {
	return &value
}

func pdfDescriptor(itemID string, version int, current bool, body []byte) nixarchive.FileVersionEntry {
	digest := sha256.Sum256(body)
	return nixarchive.FileVersionEntry{
		ItemID: itemID, Version: version, Current: current, FileName: "report.pdf", MediaType: "application/pdf",
		ByteLength: int64(len(body)), SHA256: hex.EncodeToString(digest[:]), Previewable: true,
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
