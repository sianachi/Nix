package companion

import _ "embed"

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
