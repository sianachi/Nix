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
	names := toolNamesFor("chat")

	for _, operation := range structureOperationsInChatMode {
		if _, ok := names["nix_"+operation]; !ok {
			t.Fatalf("%q is not in workspaceTools(\"chat\")'s tool names; the fixture list is stale", operation)
		}
		if !strings.Contains(sentence, "nix_"+operation) {
			t.Errorf("chat capability sentence does not name structure tool %q: %q", "nix_"+operation, sentence)
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

// TestChatRulesDescribeBodyEditsButNeverWholeBodyReplace pins lane C's sentence: the two
// block-granular edits are named, and the pet still says it cannot replace a whole body.
func TestChatRulesDescribeBodyEditsButNeverWholeBodyReplace(t *testing.T) {
	sentence := chatRules()
	for _, want := range []string{"nix_replace_section", "nix_replace_passage", "cannot administer workspaces, replace a whole note body"} {
		if !strings.Contains(sentence, want) {
			t.Errorf("chat rules do not contain %q: %q", want, sentence)
		}
	}
	names := toolNamesFor("chat")
	for _, tool := range []string{"nix_replace_section", "nix_replace_passage"} {
		if _, ok := names[tool]; !ok {
			t.Errorf("%s is named in the chat rules but not offered in chat", tool)
		}
	}
}
