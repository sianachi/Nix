package companion

import (
	"strings"
	"testing"
)

// structureOperationsInChatMode names the nix_workspace operations that build or extend
// structure from a specJson, as opposed to the plain item operations (create_note,
// set_properties, ...) and the template operations (list_templates, read_template,
// apply_template). It mirrors packages/structure-spec/src/catalog/tables.ts's
// STRUCTURE_OPERATIONS.chat. TestCatalogNamesEveryOperationInItsMode checks each of these
// names against workspaceTools()'s own enum and against the embedded chat text; it does not
// discover structure operations the schema knows about but this list has fallen out of step
// with - a structure operation added to workspaceTools() and forgotten here would not fail
// this test. Nothing in the schema marks an operation as "structure-shaped", so there is no
// enum to derive the other direction from without inventing one.
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
	enum := workspaceOperationEnum(t)

	for _, operation := range structureOperationsInChatMode {
		found := false
		for _, candidate := range enum {
			if candidate == operation {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%q is not in workspaceTools()'s operation enum; the fixture list is stale", operation)
		}
		if !strings.Contains(chatCatalog, operation) {
			t.Errorf("chat catalog does not name structure operation %q", operation)
		}
	}
}

// workspaceOperationEnum reads the "operation" property's enum straight out of workspaceTools(),
// rather than a second hand-typed copy of it, so a structure operation renamed in the schema and
// forgotten in structureOperationsInChatMode fails TestCatalogNamesEveryOperationInItsMode instead
// of two lists silently agreeing with each other and disagreeing with the schema.
func workspaceOperationEnum(t *testing.T) []string {
	t.Helper()

	tools := workspaceTools()
	if len(tools) != 1 {
		t.Fatalf("workspaceTools() returned %d tools, want 1", len(tools))
	}
	tool, ok := tools[0].(map[string]any)
	if !ok {
		t.Fatalf("workspaceTools()[0] is %T, want map[string]any", tools[0])
	}
	inputSchema, ok := tool["inputSchema"].(map[string]any)
	if !ok {
		t.Fatalf("inputSchema is %T, want map[string]any", tool["inputSchema"])
	}
	properties, ok := inputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("properties is %T, want map[string]any", inputSchema["properties"])
	}
	operation, ok := properties["operation"].(map[string]any)
	if !ok {
		t.Fatalf("operation property is %T, want map[string]any", properties["operation"])
	}
	// workspaceTools() builds this as a Go []string literal (tools.go), never via
	// json.Unmarshal (which would produce []any), so this assertion holds for as long as the
	// schema is constructed in Go rather than parsed from JSON.
	enum, ok := operation["enum"].([]string)
	if !ok {
		t.Fatalf("operation enum is %T, want []string", operation["enum"])
	}
	return enum
}
