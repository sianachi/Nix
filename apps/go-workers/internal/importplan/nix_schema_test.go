package importplan

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestNixSchemaAcceptsEveryNativePropertyType(t *testing.T) {
	var definitions []map[string]any
	if err := json.Unmarshal(nativePropertyDefinitions(t), &definitions); err != nil {
		t.Fatal(err)
	}
	for _, definition := range definitions {
		t.Run(definition["type"].(string), func(t *testing.T) {
			encoded, err := json.Marshal([]map[string]any{definition})
			if err != nil {
				t.Fatal(err)
			}
			if err := validateNixSchema(&nixSchemaSnapshot{Properties: encoded, Declared: encoded}); err != nil {
				t.Fatalf("native property rejected: %v", err)
			}
		})
	}
}

func TestNixSchemaRejectsTypeOutsideBackendPropertyContract(t *testing.T) {
	schema := &nixSchemaSnapshot{
		Properties: json.RawMessage(`[ {"key":"assignee","type":"principal"} ]`),
		Declared:   json.RawMessage(`[]`),
	}
	if err := validateNixSchema(schema); err == nil {
		t.Fatal("unsupported property type accepted")
	}
}

func TestNixSchemaRejectsMalformedComputedDeclarations(t *testing.T) {
	for _, test := range []struct {
		name       string
		definition string
	}{
		{"missing expression", `{"key":"total","type":"formula"}`},
		{"null expression", `{"key":"total","type":"formula","expression":null}`},
		{"blank expression", `{"key":"total","type":"formula","expression":"  "}`},
		{"non-string expression", `{"key":"total","type":"formula","expression":42}`},
		{"long expression", `{"key":"total","type":"formula","expression":"` + strings.Repeat("a", 1025) + `"}`},
		{"long Unicode expression", `{"key":"total","type":"formula","expression":"` + strings.Repeat("\U00010000", 513) + `"}`},
		{"required formula", `{"key":"total","type":"formula","expression":"1","required":true}`},
		{"formula options", `{"key":"total","type":"formula","expression":"1","options":["One"]}`},
		{"formula aggregate", `{"key":"total","type":"formula","expression":"1","aggregate":"count"}`},
		{"missing aggregate", `{"key":"total","type":"rollup"}`},
		{"null aggregate", `{"key":"total","type":"rollup","aggregate":null}`},
		{"unknown aggregate", `{"key":"total","type":"rollup","aggregate":"median","source":"number"}`},
		{"non-string aggregate", `{"key":"total","type":"rollup","aggregate":42}`},
		{"missing source", `{"key":"total","type":"rollup","aggregate":"sum"}`},
		{"null source", `{"key":"total","type":"rollup","aggregate":"sum","source":null}`},
		{"blank source", `{"key":"total","type":"rollup","aggregate":"count","source":" "}`},
		{"non-string source", `{"key":"total","type":"rollup","aggregate":"sum","source":42}`},
		{"self source", `{"key":"total","type":"rollup","aggregate":"sum","source":"total"}`},
		{"required rollup", `{"key":"total","type":"rollup","aggregate":"count","required":true}`},
		{"rollup options", `{"key":"total","type":"rollup","aggregate":"count","options":["One"]}`},
		{"rollup expression", `{"key":"total","type":"rollup","aggregate":"count","expression":"1"}`},
		{"ordinary expression", `{"key":"text","type":"text","expression":"1"}`},
		{"ordinary aggregate", `{"key":"text","type":"text","aggregate":"count"}`},
		{"ordinary source", `{"key":"text","type":"text","source":"number"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded := json.RawMessage("[" + test.definition + "]")
			for _, schema := range []*nixSchemaSnapshot{
				{Properties: encoded, Declared: json.RawMessage(`[]`)},
				{Properties: json.RawMessage(`[]`), Declared: encoded},
			} {
				if err := validateNixSchema(schema); err == nil {
					t.Fatal("malformed computed declaration accepted")
				}
			}
		})
	}
}

func TestNixSchemaAcceptsNullableMetadataAndAllRollupAggregates(t *testing.T) {
	for _, definition := range []string{
		`{"key":"text","type":"text","expression":null,"aggregate":null,"source":null}`,
		`{"key":"total","type":"formula","expression":"1","aggregate":null,"source":null}`,
		`{"key":"total","type":"formula","expression":"` + strings.Repeat("\U00010000", 512) + `"}`,
		`{"key":"total","type":"rollup","aggregate":"count","expression":null,"source":null}`,
		`{"key":"total","type":"rollup","aggregate":"count"}`,
		`{"key":"total","type":"rollup","aggregate":"sum","source":"number"}`,
		`{"key":"total","type":"rollup","aggregate":"sum","source":"` + strings.Repeat("a", 201) + `"}`,
		`{"key":"total","type":"rollup","aggregate":"min","source":"number"}`,
		`{"key":"total","type":"rollup","aggregate":"max","source":"number"}`,
		`{"key":"total","type":"rollup","aggregate":"average","source":"number"}`,
		`{"key":"total","type":"rollup","aggregate":"any","source":"checkbox"}`,
		`{"key":"total","type":"rollup","aggregate":"all","source":"checkbox"}`,
	} {
		encoded := json.RawMessage("[" + definition + "]")
		if err := validateNixSchema(&nixSchemaSnapshot{Properties: encoded, Declared: encoded}); err != nil {
			t.Fatalf("valid computed metadata rejected: %s: %v", definition, err)
		}
	}
}

func TestNixComputedSchemasSurviveOrdinaryAndTemplatePreviewCommit(t *testing.T) {
	rootDefinitions := nativePropertyDefinitions(t)
	childDefinitions := json.RawMessage(`[{"key":"child_total","label":"Child total","type":"formula","expression":"IF([number] > 0, [number] * 2, 0)","options":[],"required":false,"aggregate":null,"source":null},{"key":"child_count","label":"Children","type":"rollup","aggregate":"count","source":null,"expression":null,"options":[],"required":false}]`)
	childEffective := json.RawMessage(strings.TrimSuffix(string(rootDefinitions), "]") + "," + strings.TrimPrefix(string(childDefinitions), "["))
	rootID := templateRoot
	manifest := nixManifest{
		Format: nixArchiveFormat, FormatVersion: nixArchiveVersion, SchemaVersion: nixSchemaMaximum,
		ExportedAt: "2026-10-11T12:00:00Z", Root: templateRoot,
		Profile:             json.RawMessage(`{"kind":"template","version":1,"key":"computed.properties","name":"Computed properties","description":"","includeBody":false,"includeChildren":true}`),
		RootEffectiveSchema: &nixSchemaSnapshot{Properties: rootDefinitions, Declared: json.RawMessage(`[]`), Inherit: true},
		Items: []nixManifestItem{
			{ID: templateRoot, Sequence: "1", Title: "Root", Type: "note"},
			{ID: templateChild, ParentID: &rootID, Sequence: "2", Title: "Child", Type: "note"},
		},
		Omitted: []nixOmission{}, Loss: []nixLoss{},
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	entries := []zipFixture{{"manifest.json", manifestBytes}}
	for _, entry := range manifest.Items {
		schema := &nixSchemaSnapshot{Properties: rootDefinitions, Declared: json.RawMessage(`[]`), Inherit: true}
		if entry.ID == templateChild {
			schema.Properties = childEffective
			schema.Declared = childDefinitions
		}
		bundleBytes, err := json.Marshal(nixBundle{
			ID: entry.ID, ParentID: entry.ParentID, WorkspaceID: templateWorkspace,
			Type: entry.Type, Title: entry.Title, Sequence: entry.Sequence, LifecycleState: "active",
			CreatedAt: manifest.ExportedAt, UpdatedAt: manifest.ExportedAt,
			Properties: json.RawMessage(`{}`), Schema: schema, ViewRows: json.RawMessage(`[]`),
		})
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, zipFixture{"items/" + entry.ID + ".json", bundleBytes})
	}
	source := zipSource(t, "computed.nix", "nix", entries)
	assertSchemas := func(t *testing.T, schemas []json.RawMessage) {
		t.Helper()
		for i, expectedProperties := range []json.RawMessage{rootDefinitions, childDefinitions} {
			var actual struct {
				Properties json.RawMessage `json:"properties"`
				Inherit    bool            `json:"inherit"`
			}
			if err := json.Unmarshal(schemas[i], &actual); err != nil {
				t.Fatal(err)
			}
			var actualDefinitions, expectedDefinitions any
			if err := json.Unmarshal(actual.Properties, &actualDefinitions); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(expectedProperties, &expectedDefinitions); err != nil {
				t.Fatal(err)
			}
			if actual.Inherit != (i == 1) || !reflect.DeepEqual(actualDefinitions, expectedDefinitions) {
				t.Fatalf("schema %d changed: %s", i, schemas[i])
			}
		}
	}
	t.Run("ordinary", func(t *testing.T) {
		plan, err := Parse(context.Background(), source, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		assertSchemas(t, []json.RawMessage{plan.Items[0].Schema, plan.Items[1].Schema})
		encoded, digest, err := Encode(plan, testLimits().MaxPlanBytes)
		if err != nil {
			t.Fatal(err)
		}
		committed, err := Decode(encoded, digest, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		assertSchemas(t, []json.RawMessage{committed.Items[0].Schema, committed.Items[1].Schema})
	})
	t.Run("template", func(t *testing.T) {
		plan, err := ParseTemplate(context.Background(), source, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		assertSchemas(t, []json.RawMessage{plan.Items[0].Schema, plan.Items[1].Schema})
		encoded, digest, err := EncodeTemplate(plan, testLimits().MaxPlanBytes)
		if err != nil {
			t.Fatal(err)
		}
		committed, err := DecodeTemplate(encoded, digest, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		assertSchemas(t, []json.RawMessage{committed.Items[0].Schema, committed.Items[1].Schema})
	})
}

func nativePropertyDefinitions(t *testing.T) json.RawMessage {
	t.Helper()
	definitions := make([]map[string]any, 0, 20)
	for _, propertyType := range []string{
		"text", "number", "select", "multi_select", "date", "checkbox", "url", "timestamp", "image",
		"due_date", "start_date", "completion", "priority", "estimate", "assignee", "formula", "rollup", "datetime", "reminder", "long_text",
	} {
		definition := map[string]any{
			"key": propertyType, "label": propertyType, "type": propertyType, "required": false,
			"options": []string{}, "expression": nil, "aggregate": nil, "source": nil,
		}
		switch propertyType {
		case "select", "multi_select":
			definition["options"] = []string{"Open", "Done"}
		case "formula":
			definition["expression"] = `[number] * 2`
		case "rollup":
			definition["aggregate"] = "sum"
			definition["source"] = "number"
		}
		definitions = append(definitions, definition)
	}
	encoded, err := json.Marshal(definitions)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
