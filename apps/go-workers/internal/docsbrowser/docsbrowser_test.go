package docsbrowser

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const rootID = "11111111-1111-5111-a111-111111111111"
const guideID = "22222222-2222-5222-a222-222222222222"
const sourceID = "33333333-3333-5333-a333-333333333333"
const missingID = "44444444-4444-5444-a444-444444444444"
const original = "# Original café\r\n\r\n```mermaid\r\nflowchart LR\r\n A --> B\r\n```\r\n"

type fixture struct {
	root     string
	manifest nixarchive.Manifest
	bundles  []nixarchive.Bundle
	catalog  catalog
}

func paragraph(value string) node {
	return node{Type: "paragraph", Content: []node{{Type: "text", Text: value}}}
}
func makeBundle(t *testing.T, id string, parent *string, title string, content ...node) nixarchive.Bundle {
	t.Helper()
	body, err := json.Marshal(map[string]any{"prosemirror": node{Type: "doc", Content: content}})
	if err != nil {
		t.Fatal(err)
	}
	return nixarchive.Bundle{ID: id, ParentID: parent, Seq: "1024", Title: title, Type: "note", Body: body}
}
func makeFixture(t *testing.T) *fixture {
	t.Helper()
	root, guide := rootID, guideID
	f := &fixture{root: t.TempDir()}
	f.bundles = []nixarchive.Bundle{
		makeBundle(t, rootID, nil, "Handbook", node{Type: "paragraph", Content: []node{{Type: "reference", Attrs: map[string]any{"targetId": guideID, "label": "Database guide"}}, {Type: "reference", Attrs: map[string]any{"targetId": missingID, "label": "External note"}}}}),
		makeBundle(t, guideID, &root, "Database guide", paragraph("Database service details")),
		makeBundle(t, sourceID, &guide, "Original source", node{Type: "codeBlock", Content: []node{{Type: "text", Text: original}}}),
	}
	f.manifest = nixarchive.Manifest{Format: nixarchive.Format, FormatVersion: 1, Root: rootID}
	for _, b := range f.bundles {
		f.manifest.Items = append(f.manifest.Items, nixarchive.ManifestItem{ID: b.ID, ParentID: b.ParentID, Seq: b.Seq, Title: b.Title, Type: b.Type})
	}
	f.catalog = catalog{Pages: []record{{Slug: "database", ItemID: guideID, Archive: "docs/nix/fixture.nix", Title: "Database guide"}}, Documents: []record{{SourcePath: "original.md", Title: "Original source", ItemID: sourceID, SourceItemID: sourceID, Archive: "docs/nix/fixture.nix", SourceSHA256: checksum([]byte(original)), SourceBytes: len(original)}}}
	f.write(t, false)
	return f
}
func (f *fixture) write(t *testing.T, duplicate bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(f.root, "docs/nix"), 0700); err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	write := func(name string, value any) {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(encoded); err != nil {
			t.Fatal(err)
		}
	}
	write("manifest.json", f.manifest)
	for _, b := range f.bundles {
		write("items/"+b.ID+".json", b)
	}
	if duplicate {
		write("items/"+rootID+".json", f.bundles[0])
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "docs/nix/fixture.nix"), data.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	f.catalog.Archives = []descriptor{{Path: "docs/nix/fixture.nix", SHA256: checksum(data.Bytes()), ItemCount: len(f.bundles)}}
	encoded, err := json.Marshal(f.catalog)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "docs/nix/catalog.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
}
func fixtureState(t *testing.T) (*fixture, *state) {
	t.Helper()
	f := makeFixture(t)
	lib, err := load(f.root)
	if err != nil {
		t.Fatal(err)
	}
	state, err := newState(lib, "")
	if err != nil {
		t.Fatal(err)
	}
	return f, state
}
func TestReadArchiveAndExactUTF8Source(t *testing.T) {
	f := makeFixture(t)
	lib, err := load(f.root)
	if err != nil {
		t.Fatal(err)
	}
	source, err := originalSource(lib.Archives[f.catalog.Archives[0].Path][2])
	if err != nil {
		t.Fatal(err)
	}
	if source != original {
		t.Fatalf("source changed: %q", source)
	}
}
func TestReadProseOnlyV2(t *testing.T) {
	f := makeFixture(t)
	f.manifest.FormatVersion = 2
	f.manifest.Files = []nixarchive.FileVersionEntry{}
	f.write(t, false)
	if _, err := load(f.root); err != nil {
		t.Fatal(err)
	}
}
func TestArchiveRejectsChecksumDuplicatesEnvelopeAndParent(t *testing.T) {
	for _, kind := range []string{"checksum", "duplicates", "envelope", "parent", "files", "loss", "path"} {
		t.Run(kind, func(t *testing.T) {
			f := makeFixture(t)
			switch kind {
			case "checksum":
				f.catalog.Archives[0].SHA256 = strings.Repeat("0", 64)
			case "duplicates":
				f.write(t, true)
			case "envelope":
				f.bundles[1].Title = "Changed"
				f.write(t, false)
			case "parent":
				parent := missingID
				f.bundles[1].ParentID = &parent
				f.manifest.Items[1].ParentID = &parent
				f.write(t, false)
			case "files":
				f.manifest.FormatVersion = 2
				f.manifest.Files = []nixarchive.FileVersionEntry{{ItemID: guideID}}
				f.write(t, false)
			case "loss":
				f.manifest.Loss = []nixarchive.LossEntry{{ItemID: guideID, Kind: "unsupported", Detail: "lost content"}}
				f.write(t, false)
			case "path":
				f.catalog.Archives[0].Path = "../escape.nix"
			}
			if _, err := readArchive(f.root, f.catalog.Archives[0]); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestSourceHashMismatchRejected(t *testing.T) {
	f := makeFixture(t)
	f.catalog.Documents[0].SourceSHA256 = strings.Repeat("0", 64)
	f.write(t, false)
	if _, err := load(f.root); err == nil || !strings.Contains(err.Error(), "source preservation") {
		t.Fatalf("got %v", err)
	}
}
func TestBoundedReadRejectsOversize(t *testing.T) {
	if _, err := boundedRead(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("unbounded input accepted")
	}
}
func TestSelectExactAliasAndRefuseAmbiguousTitle(t *testing.T) {
	f := makeFixture(t)
	lib, err := load(f.root)
	if err != nil {
		t.Fatal(err)
	}
	lib.Catalog.Pages = append(lib.Catalog.Pages, record{Slug: "database-auth", ItemID: missingID, Title: "Database auth"})
	row, err := lib.selectRecord("database")
	if err != nil || row.ItemID != guideID {
		t.Fatalf("got %v, %v", row, err)
	}
	if _, err := lib.selectRecord("Database "); err == nil {
		t.Fatal("ambiguous title accepted")
	}
}
func TestTreeIncludesRootGroupsAndSourceChildren(t *testing.T) {
	_, s := fixtureState(t)
	if len(s.Notes) != 3 || s.Notes[0].ID != rootID || s.Notes[2].ID != sourceID || s.Notes[2].Depth != 2 {
		t.Fatalf("tree: %+v", s.Notes)
	}
	s.move(1)
	if s.Notes[s.Current].ID != guideID {
		t.Fatal("tree navigation failed")
	}
	s.move(20)
	if s.Notes[s.Current].ID != sourceID {
		t.Fatal("last row clamp failed")
	}
	s.move(-20)
	if s.Notes[s.Current].ID != rootID {
		t.Fatal("first row clamp failed")
	}
}
func TestFullTextSearchNativeLinksAndHistory(t *testing.T) {
	_, s := fixtureState(t)
	s.search("DATABASE GUIDE")
	s.Scroll = 5
	s.Horizontal = 8
	before := s.location()
	if !strings.HasPrefix(s.follow(), "Opened") || s.Notes[s.Current].ID != guideID || s.Query != "" {
		t.Fatal("link follow failed")
	}
	if !strings.HasPrefix(s.back(), "Returned") || s.location() != before {
		t.Fatalf("history did not restore: %+v", s.location())
	}
	s.LinkCursor = 1
	if !strings.Contains(s.follow(), "outside") || len(s.History) != 0 {
		t.Fatal("external link changed state")
	}
	s.search("café")
	if len(s.Visible) != 1 || s.Notes[s.Current].ID != sourceID {
		t.Fatal("source text not searchable")
	}
	s.search("original.md")
	if len(s.Visible) != 1 {
		t.Fatal("catalog path not searchable")
	}
	s.search("no such phrase")
	if len(s.Visible) != 0 {
		t.Fatal("empty results not preserved")
	}
	ui := tui{state: s}
	if !strings.Contains(ui.frame(80, 24), "No matching notes") {
		t.Fatal("empty search not rendered")
	}
}
func TestRenderReadableBlocksAndExactMermaid(t *testing.T) {
	code := "flowchart LR\n  A[Database] --> B[Worker]"
	bundle := makeBundle(t, rootID, nil, "Diagram", node{Type: "heading", Attrs: map[string]any{"level": float64(2)}, Content: []node{{Type: "text", Text: "Architecture"}}}, node{Type: "bulletList", Content: []node{{Type: "listItem", Content: []node{node{Type: "paragraph", Content: []node{{Type: "text", Text: "First item", Marks: []node{{Type: "bold"}}}}}}}}}, node{Type: "codeBlock", Attrs: map[string]any{"language": "mermaid"}, Content: []node{{Type: "text", Text: code}}})
	document, _, err := renderBundle(bundle, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(document, "## Architecture") || !strings.Contains(document, "- **First item**") || !strings.Contains(document, "```mermaid\n"+code+"\n```") {
		t.Fatalf("bad rendering %q", document)
	}
	wrapped := wrapDocument(document, 8)
	found := false
	for _, line := range wrapped {
		if line.Text == "  A[Database] --> B[Worker]" && line.Code {
			found = true
		}
	}
	if !found {
		t.Fatal("Mermaid code was wrapped or changed")
	}
}
func TestTerminalCellClippingAndControlSanitization(t *testing.T) {
	if got := cellSlice("A界B", 1, 2); got != "界" {
		t.Fatalf("wide clipping %q", got)
	}
	if got := cellSlice("é\u0301x", 0, 1); got != "é\u0301" {
		t.Fatalf("combining clipping %q", got)
	}
	if got := cellSlice("name\x1b[2J\u202e", 0, 40); strings.ContainsAny(got, "\x1b\u202e") {
		t.Fatal("terminal controls escaped sanitization")
	}
}
func TestWrapDocumentMakesProgressWithWideTextAndIndentation(t *testing.T) {
	for _, width := range []int{1, 2, 35} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			text := strings.Repeat(" ", width-1) + "界界"
			wrapped := wrapDocument(text, width)
			var content strings.Builder
			for _, line := range wrapped {
				content.WriteString(strings.TrimSpace(line.Text))
			}
			if content.String() != "界界" || len(wrapped) > 3 {
				t.Fatalf("wide text lost or wrapping failed to progress: %+v", wrapped)
			}
		})
	}
}
func TestKeyParserHandlesFragmentedSequencesAndUTF8(t *testing.T) {
	parser := keyParser{}
	if keys := parser.feed([]byte("\x1b["), false); len(keys) != 0 {
		t.Fatal(keys)
	}
	keys := parser.feed([]byte("A\x1b[6~\t\r"), false)
	if strings.Join(keys, ",") != "up,pagedown,tab,enter" {
		t.Fatal(keys)
	}
	if keys := parser.feed([]byte{0xc3}, false); len(keys) != 0 {
		t.Fatal(keys)
	}
	if keys := parser.feed([]byte{0xa9}, false); len(keys) != 1 || keys[0] != "é" {
		t.Fatal(keys)
	}
	parser.feed([]byte{27}, false)
	if keys := parser.feed(nil, true); len(keys) != 1 || keys[0] != "escape" {
		t.Fatal(keys)
	}
	if keys := parser.feed([]byte("\x1b[99~q\x03"), false); strings.Join(keys, ",") != "q,quit" {
		t.Fatal(keys)
	}
}
func TestTUIKeysSearchCancelLinkFollowBackAndResize(t *testing.T) {
	_, s := fixtureState(t)
	ui := tui{state: s}
	ui.key("/", 18)
	for _, char := range "café" {
		ui.key(string(char), 18)
	}
	if !ui.Searching || s.Notes[s.Current].ID != sourceID {
		t.Fatal("interactive search failed")
	}
	ui.key("escape", 18)
	if ui.Searching || s.Current != 0 || s.Query != "" {
		t.Fatal("search cancellation failed")
	}
	ui.key("tab", 18)
	ui.key("enter", 18)
	if !ui.Reader || s.Notes[s.Current].ID != guideID {
		t.Fatal("reader link follow failed")
	}
	ui.key("b", 18)
	if s.Current != 0 {
		t.Fatal("back failed")
	}
	if !strings.Contains(ui.frame(30, 5), "enlarge terminal") {
		t.Fatal("small terminal guard missing")
	}
	if !strings.Contains(ui.frame(120, 30), "offline native archives") {
		t.Fatal("resize did not redraw")
	}
	if !ui.key("q", 18) {
		t.Fatal("quit not handled")
	}
}
func TestOfflineCommandsPreserveSourceAndRejectNonTTY(t *testing.T) {
	f := makeFixture(t)
	t.Chdir(f.root)
	var output bytes.Buffer
	if err := Run([]string{"source", "original.md"}, os.Stdin, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != original {
		t.Fatalf("source bytes changed %q", output.String())
	}
	output.Reset()
	if err := Run([]string{"check"}, os.Stdin, &output); err != nil || !strings.Contains(output.String(), "1 exact source") {
		t.Fatalf("check: %q %v", output.String(), err)
	}
	output.Reset()
	if err := Run([]string{"list"}, os.Stdin, &output); err != nil || !strings.Contains(output.String(), "database\tDatabase guide") {
		t.Fatalf("list: %q %v", output.String(), err)
	}
	output.Reset()
	if err := Run([]string{"read", "database"}, os.Stdin, &output); err != nil || !strings.Contains(output.String(), "Database service details") {
		t.Fatalf("read: %q %v", output.String(), err)
	}
	if err := Run(nil, os.Stdin, &output); err == nil || !strings.Contains(err.Error(), "interactive terminal") {
		t.Fatalf("non-TTY: %v", err)
	}
}
