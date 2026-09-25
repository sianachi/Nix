package companion

import _ "embed"

//go:embed catalog/chat.txt
var chatCatalog string

// catalogFor returns the capability catalog appended to a mode's base instructions.
// Consult mode gets its own, larger catalog in task D.1b.
func catalogFor(mode string) string {
	return chatCatalog
}
