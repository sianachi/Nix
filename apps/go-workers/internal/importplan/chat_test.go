package importplan

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNativeChatViewAndMessageFieldsSurvivePreviewCommit(t *testing.T) {
	definitions := json.RawMessage(`[{"key":"chat_role","label":"Role","type":"select","options":["user","assistant","system"],"required":true},{"key":"chat_text","label":"Text","type":"text","required":true},{"key":"chat_created_at","label":"Created","type":"date","required":true},{"key":"chat_author","label":"Author","type":"text","required":false}]`)
	views := json.RawMessage(`{"default":"conversation","views":[{"id":"conversation","name":"Chat","kind":"chat","sortBy":"chat_created_at"}]}`)
	properties := json.RawMessage(`{"chat_role":"assistant","chat_text":"Saved insight","chat_created_at":"2026-10-15T12:00:00Z","chat_author":"Pet"}`)
	root := templateRoot
	manifest := nixManifest{Format: nixArchiveFormat, FormatVersion: nixArchiveVersion, SchemaVersion: nixSchemaMaximum, ExportedAt: "2026-10-15T12:00:00Z", Root: root, RootEffectiveSchema: &nixSchemaSnapshot{Properties: definitions, Declared: definitions}, Items: []nixManifestItem{{ID: root, Sequence: "1", Title: "Conversation", Type: "note"}, {ID: templateChild, ParentID: &root, Sequence: "2", Title: "Saved message", Type: "note"}}, Omitted: []nixOmission{}, Loss: []nixLoss{}}
	manifestBytes, _ := json.Marshal(manifest)
	entries := []zipFixture{{"manifest.json", manifestBytes}}
	for _, entry := range manifest.Items {
		bundle := nixBundle{ID: entry.ID, ParentID: entry.ParentID, WorkspaceID: templateWorkspace, Type: "note", Title: entry.Title, Sequence: entry.Sequence, LifecycleState: "active", CreatedAt: manifest.ExportedAt, UpdatedAt: manifest.ExportedAt, Properties: json.RawMessage(`{}`), ViewRows: json.RawMessage(`[]`)}
		if entry.ID == root {
			bundle.Schema = manifest.RootEffectiveSchema
			bundle.Views = views
		} else {
			bundle.Properties = properties
		}
		encoded, err := json.Marshal(bundle)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, zipFixture{"items/" + entry.ID + ".json", encoded})
	}
	source := zipSource(t, "conversation.nix", "nix", entries)
	plan, err := Parse(context.Background(), source, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	encoded, digest, err := Encode(plan, testLimits().MaxPlanBytes)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := Decode(encoded, digest, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []Plan{plan, committed} {
		var gotViews, wantViews, gotProperties, wantProperties any
		_ = json.Unmarshal(result.Items[0].Views, &gotViews)
		_ = json.Unmarshal(views, &wantViews)
		_ = json.Unmarshal(result.Items[1].Properties, &gotProperties)
		_ = json.Unmarshal(properties, &wantProperties)
		var schema struct {
			Properties json.RawMessage `json:"properties"`
		}
		_ = json.Unmarshal(result.Items[0].Schema, &schema)
		var gotDefinitions, wantDefinitions any
		_ = json.Unmarshal(schema.Properties, &gotDefinitions)
		_ = json.Unmarshal(definitions, &wantDefinitions)
		if !reflect.DeepEqual(gotViews, wantViews) || !reflect.DeepEqual(gotProperties, wantProperties) || !reflect.DeepEqual(gotDefinitions, wantDefinitions) {
			t.Fatalf("chat content changed: %+v", result.Items)
		}
	}
}
