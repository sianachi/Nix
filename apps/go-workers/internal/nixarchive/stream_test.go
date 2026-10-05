package nixarchive

import (
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

func TestReadBundleStreamRequiresMatchingSentinelAndOrder(t *testing.T) {
	root := "123e4567-e89b-12d3-a456-426614174000"
	payload := `{"format":"nix-archive","formatVersion":1,"schemaVersion":3,"exportedAt":"2026-08-31T00:00:00Z","root":"` + root + `","rootEffectiveSchema":null,"includesDeleted":false,"items":[{"id":"` + root + `","parentId":null,"seq":"1","title":"Root","type":"note"}],"omitted":[],"loss":[]}` + "\n" +
		`{"id":"` + root + `","parentId":null,"workspaceId":"workspace","type":"note","title":"Root","seq":"1","lifecycleState":"active","createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","properties":{},"schema":null,"views":null,"viewRows":[],"viewRowsTruncated":false,"body":{"schemaVersion":3,"prosemirror":{"type":"doc"}}}` + "\n" +
		`{"end":true,"items":1}` + "\n"
	manifest, bundles, err := ReadBundleStream(strings.NewReader(payload), stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10})
	if err != nil || manifest.Root != root || len(bundles) != 1 {
		t.Fatalf("manifest = %#v, bundles = %#v, error = %v", manifest, bundles, err)
	}
	if _, _, err := ReadBundleStream(strings.NewReader(strings.Replace(payload, `"items":1`, `"items":2`, 1)), stream.Limits{MaxBytes: 1 << 20, MaxLine: 1 << 20, MaxRecords: 10}); err == nil {
		t.Fatal("incorrect sentinel was accepted")
	}
}
