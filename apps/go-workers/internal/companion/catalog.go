package companion

import (
	_ "embed"
	"strings"
)

//go:embed catalog/chat.txt
var chatCatalog string

//go:embed catalog/consult.txt
var consultCatalog string

// catalogFor returns the capability catalog appended to a mode's base instructions.
func catalogFor(mode string) string {
	if mode == "consult" {
		return consultCatalog
	}
	return chatCatalog
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
