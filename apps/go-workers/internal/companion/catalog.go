package companion

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

//go:embed catalog/chat.txt
var chatCatalog string

//go:embed catalog/consult.txt
var consultCatalog string

// toolsChatJSON and toolsConsultJSON are @nix/structure-spec's buildPetTools('chat'/'consult'),
// written by `pnpm --filter @nix/structure-spec catalog` (scripts/build-catalog.ts) from the same
// Zod schemas @nix/companion/run.ts parses with. One typed function tool per operation, each
// already reduced to the JSON Schema keys Codex 0.153.4 keeps and, per
// docs/plans/pet-speed-accuracy-plan.md L1.2, at or under its 4800-byte normalized budget - see
// catalog_test.go's TestEmbeddedToolSchemasFitTheCodexBudget, which re-measures with the same key
// filter in Go rather than trusting the TS side alone.
//
//go:embed catalog/tools-chat.json
var toolsChatJSON []byte

//go:embed catalog/tools-consult.json
var toolsConsultJSON []byte

// petTool is one entry of the embedded tools-chat.json / tools-consult.json: a typed
// nix_<operation> function tool, exactly as `dynamicTools` in `turn/start`/`thread/start` needs
// it (see manager.go's send).
type petTool struct {
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var (
	toolsChat        []petTool
	toolsConsult     []petTool
	toolNamesChat    map[string]struct{}
	toolNamesConsult map[string]struct{}
	// consultOnlyOperations are the operations available only in consult (Design mode)
	// conversations: designing and saving a whole structure, as opposed to the additive,
	// one-item-at-a-time operations chat also has. Derived at init from the generated catalog
	// itself (consult tool names minus chat tool names) rather than hand-listed, so it can
	// never drift from workspaceTools(mode); validateToolArguments uses it to refuse a
	// consult-only operation's flattened call in chat.
	consultOnlyOperations []string
)

func init() {
	if err := json.Unmarshal(toolsChatJSON, &toolsChat); err != nil {
		panic(fmt.Sprintf("catalog/tools-chat.json is invalid: %v", err))
	}
	if err := json.Unmarshal(toolsConsultJSON, &toolsConsult); err != nil {
		panic(fmt.Sprintf("catalog/tools-consult.json is invalid: %v", err))
	}
	toolNamesChat = toolNameSet(toolsChat)
	toolNamesConsult = toolNameSet(toolsConsult)
	consultOnlyOperations = deriveConsultOnlyOperations(toolNamesConsult, toolNamesChat)
}

func toolNameSet(tools []petTool) map[string]struct{} {
	names := make(map[string]struct{}, len(tools))
	for _, tool := range tools {
		names[tool.Name] = struct{}{}
	}
	return names
}

// deriveConsultOnlyOperations returns the operation names (without their nix_ prefix) present
// in consultNames but not chatNames, sorted for a deterministic result.
func deriveConsultOnlyOperations(consultNames, chatNames map[string]struct{}) []string {
	operations := make([]string, 0, len(consultNames))
	for name := range consultNames {
		if _, inChat := chatNames[name]; !inChat {
			operations = append(operations, operationFromToolName(name))
		}
	}
	sort.Strings(operations)
	return operations
}

// catalogFor returns the capability catalog appended to a mode's base instructions.
func catalogFor(mode string) string {
	if mode == "consult" {
		return consultCatalog
	}
	return chatCatalog
}

// workspaceTools returns the mode's typed per-operation tools as the `[]any` of
// `{"type":"function","name",...}` maps `dynamicTools` expects. Parsed once at init from the
// generated catalog rather than built in Go, so this and @nix/structure-spec's buildPetTools can
// never drift: a schema change on one side without regenerating the other fails
// changed-path-checks.sh's catalog diff, not this function. tools.go's hand-written toolArgSpecs
// is a separate table that is not generated from this catalog and can drift from it on its own;
// TestToolArgSpecsMatchGeneratedSchemas (tools_test.go) checks the two against each other.
func workspaceTools(mode string) []any {
	tools := toolsChat
	if mode == "consult" {
		tools = toolsConsult
	}
	result := make([]any, len(tools))
	for i, tool := range tools {
		result[i] = map[string]any{
			"type":        "function",
			"name":        tool.Name,
			"description": tool.Description,
			"inputSchema": tool.InputSchema,
		}
	}
	return result
}

// toolNamesFor returns the set of tool names (`nix_<operation>`) offered in mode, used to reject
// `nix_workspace` and anything else `toolRequest` sees before flattening it.
func toolNamesFor(mode string) map[string]struct{} {
	if mode == "consult" {
		return toolNamesConsult
	}
	return toolNamesChat
}

// operationFromToolName strips the "nix_" prefix a typed tool name always carries. Callers
// already know the name is in toolNamesFor(mode), so the prefix is always present.
func operationFromToolName(tool string) string {
	return strings.TrimPrefix(tool, "nix_")
}

// structureOperations reads the "Section: Structure operations" line straight out of
// mode's embedded catalog, instead of a second hand-typed list, so the chat capability
// sentence (chatRules) can never fall out of step with the catalog and workspaceTools(mode)
// the way it did when B.4 added add_fields, edit_form and set_recurrence without updating
// the base instructions sentence.
func structureOperations(mode string) []string {
	const marker = "Section: Structure operations\n"
	catalog := catalogFor(mode)
	start := strings.Index(catalog, marker)
	if start == -1 {
		return nil
	}
	rest := catalog[start+len(marker):]
	line := rest
	if end := strings.IndexByte(rest, '\n'); end != -1 {
		line = rest[:end]
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	parts := strings.Split(line, ", ")
	operations := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			operations = append(operations, trimmed)
		}
	}
	return operations
}
