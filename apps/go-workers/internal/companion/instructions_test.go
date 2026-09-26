package companion

import (
	"strings"
	"testing"
)

// TestChatCapabilitySentenceNamesEveryStructureOperation guards against the drift the
// orchestrator found in D.1b: the chat base instructions once named only create_structured,
// add_view and create_entries even after B.4 added add_fields, edit_form and set_recurrence
// to workspaceTools("chat"). chatRules now builds its sentence from the catalog's own
// "Structure operations" line (structureOperations), so this test pins that every operation
// the catalog and the enum agree on is also named in the sentence the model reads.
func TestChatCapabilitySentenceNamesEveryStructureOperation(t *testing.T) {
	sentence := chatRules()
	enum := workspaceOperationEnum(t, "chat")

	for _, operation := range structureOperationsInChatMode {
		found := false
		for _, candidate := range enum {
			if candidate == operation {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%q is not in workspaceTools(\"chat\")'s operation enum; the fixture list is stale", operation)
		}
		if !strings.Contains(sentence, operation) {
			t.Errorf("chat capability sentence does not name structure operation %q: %q", operation, sentence)
		}
	}
}

func TestModeRulesSelectsConsultOnlyForConsult(t *testing.T) {
	if modeRules("consult") != consultRules {
		t.Fatal("consult mode did not receive consultRules")
	}
	for _, mode := range []string{"", "chat", "unknown"} {
		if modeRules(mode) != chatRules() {
			t.Fatalf("mode %q did not fall back to chatRules", mode)
		}
	}
}

func TestConsultRulesNamesEveryConsultOnlyOperation(t *testing.T) {
	for _, operation := range consultOnlyOperations {
		if !strings.Contains(consultRules, operation) {
			t.Errorf("consult rules do not mention consult-only operation %q", operation)
		}
	}
}
