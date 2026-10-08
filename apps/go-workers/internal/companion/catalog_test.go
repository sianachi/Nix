package companion

import (
	"encoding/json"
	"strings"
	"testing"
)

// structureOperationsInChatMode names the nix_<operation> tools that build or extend structure
// from a spec, as opposed to the plain item operations (create_note, set_properties, ...) and
// the template operations (list_templates, read_template, apply_template). It mirrors
// packages/structure-spec/src/catalog/tables.ts's STRUCTURE_OPERATIONS.chat.
// TestCatalogNamesEveryOperationInItsMode checks each of these names against workspaceTools()'s
// own tool names and against the embedded chat text; it does not discover structure operations
// the catalog knows about but this list has fallen out of step with - a structure operation
// added to workspaceTools() and forgotten here would not fail this test. Nothing in the schema
// marks an operation as "structure-shaped", so there is no enum to derive the other direction
// from without inventing one.
var structureOperationsInChatMode = []string{"create_structured", "add_view", "create_entries", "add_fields", "edit_form", "set_recurrence"}

func TestCatalogsAreEmbeddedAndBounded(t *testing.T) {
	if chatCatalog == "" {
		t.Fatal("chatCatalog is empty")
	}
	if len(chatCatalog) > 3000 {
		t.Fatalf("chatCatalog is %d chars, want <= 3000", len(chatCatalog))
	}
	if consultCatalog == "" {
		t.Fatal("consultCatalog is empty")
	}
	if len(consultCatalog) > 12000 {
		t.Fatalf("consultCatalog is %d chars, want <= 12000", len(consultCatalog))
	}
}

func TestCatalogNamesEveryOperationInItsMode(t *testing.T) {
	names := toolNamesFor("chat")

	for _, operation := range structureOperationsInChatMode {
		if _, ok := names["nix_"+operation]; !ok {
			t.Fatalf("%q is not in workspaceTools(\"chat\")'s tool names; the fixture list is stale", operation)
		}
		if !strings.Contains(chatCatalog, operation) {
			t.Errorf("chat catalog does not name structure operation %q", operation)
		}
	}
}

// TestConsultCatalogNamesEveryConsultOperation is TestCatalogNamesEveryOperationInItsMode's
// counterpart for consult (Design mode): the same structure operations must also be present as
// tools in workspaceTools("consult") and named in the embedded consult catalog text.
func TestConsultCatalogNamesEveryConsultOperation(t *testing.T) {
	names := toolNamesFor("consult")

	for _, operation := range structureOperationsInChatMode {
		if _, ok := names["nix_"+operation]; !ok {
			t.Fatalf("%q is not in workspaceTools(\"consult\")'s tool names; the fixture list is stale", operation)
		}
		if !strings.Contains(consultCatalog, operation) {
			t.Errorf("consult catalog does not name structure operation %q", operation)
		}
	}
}

// TestWorkspaceToolsOffersOneToolPerOperationPerMode pins the tool-name shape every other test
// in this package assumes: consult offers every WORKSPACE_OPERATIONS tool
// (packages/structure-spec/src/catalog/tables.ts), chat omits the three consult-only ones, and
// no mode offers the old single nix_workspace tool.
func TestWorkspaceToolsOffersOneToolPerOperationPerMode(t *testing.T) {
	chatNames := toolNamesFor("chat")
	consultNames := toolNamesFor("consult")

	if len(chatNames) != 23 {
		t.Fatalf("chat mode offers %d tools, want 23", len(chatNames))
	}
	if len(consultNames) != 26 {
		t.Fatalf("consult mode offers %d tools, want 26", len(consultNames))
	}
	for _, name := range []string{"nix_workspace", "workspace"} {
		if _, ok := chatNames[name]; ok {
			t.Fatalf("chat mode still offers the retired %q tool", name)
		}
	}
	for _, operation := range consultOnlyOperations {
		if _, ok := chatNames["nix_"+operation]; ok {
			t.Fatalf("chat mode offers the consult-only tool nix_%s", operation)
		}
		if _, ok := consultNames["nix_"+operation]; !ok {
			t.Fatalf("consult mode is missing its own consult-only tool nix_%s", operation)
		}
	}
}

// TestEmbeddedToolSchemasFitTheCodexBudget re-measures every embedded tool's inputSchema against
// Codex 0.153.4's own normalized-key set (docs/plans/pet-speed-accuracy-plan.md, "Codex 0.153.4
// facts"), independently of packages/structure-spec/src/catalog/tools.ts's own budget test, so a
// schema that grew past 4800 bytes on the way through JSON, embed and re-parse fails here too.
func TestEmbeddedToolSchemasFitTheCodexBudget(t *testing.T) {
	for _, mode := range []string{"chat", "consult"} {
		for _, tool := range workspaceTools(mode) {
			entry, ok := tool.(map[string]any)
			if !ok {
				t.Fatalf("%s tool is %T, want map[string]any", mode, tool)
			}
			name, _ := entry["name"].(string)
			normalized := normalizeForCodexTest(entry["inputSchema"])
			encoded, err := json.Marshal(normalized)
			if err != nil {
				t.Fatalf("%s %s: %v", mode, name, err)
			}
			if len(encoded) > 4800 {
				t.Errorf("%s %s inputSchema is %d normalized bytes, want <= 4800", mode, name, len(encoded))
			}
		}
	}
}

// codexSchemaKeys are the JSON Schema keys Codex 0.153.4's dynamic-tool sanitizer keeps (see
// packages/structure-spec/src/catalog/tools.ts's normalizeForCodex, which this mirrors in Go so
// the budget is checked independently on both sides of the embed).
var codexSchemaKeys = map[string]bool{
	"$ref": true, "type": true, "description": true, "enum": true, "items": true,
	"minItems": true, "properties": true, "required": true, "additionalProperties": true,
	"anyOf": true, "oneOf": true, "allOf": true,
}

func normalizeForCodexTest(schema any) any {
	switch value := schema.(type) {
	case bool:
		if value {
			return map[string]any{"type": "string"}
		}
		return map[string]any{}
	case map[string]any:
		result := map[string]any{}
		if constValue, ok := value["const"]; ok {
			if _, hasEnum := value["enum"]; !hasEnum {
				result["enum"] = []any{constValue}
			}
		}
		for key, raw := range value {
			if key == "const" || !codexSchemaKeys[key] {
				continue
			}
			switch key {
			case "items", "additionalProperties":
				if b, ok := raw.(bool); ok {
					result[key] = b
				} else {
					result[key] = normalizeForCodexTest(raw)
				}
			case "properties":
				properties, _ := raw.(map[string]any)
				normalizedProperties := map[string]any{}
				for propertyName, propertySchema := range properties {
					normalizedProperties[propertyName] = normalizeForCodexTest(propertySchema)
				}
				result[key] = normalizedProperties
			case "anyOf", "oneOf", "allOf":
				branches, _ := raw.([]any)
				normalizedBranches := make([]any, len(branches))
				for i, branch := range branches {
					normalizedBranches[i] = normalizeForCodexTest(branch)
				}
				result[key] = normalizedBranches
			default:
				result[key] = raw
			}
		}
		if defs, ok := value["$defs"].(map[string]any); ok {
			normalizedDefs := map[string]any{}
			for name, def := range defs {
				normalizedDefs[name] = normalizeForCodexTest(def)
			}
			result["$defs"] = normalizedDefs
		}
		return result
	default:
		return map[string]any{}
	}
}
