package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

type toolPeer struct {
	fakeTransport
	replies []any
}

func TestIdenticalToolCallsShareOneDecision(t *testing.T) {
	for _, success := range []bool{true, false} {
		t.Run(fmt.Sprint(success), func(t *testing.T) {
			peer := &toolPeer{}
			a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
			call := func(id, args string) bool {
				raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":"nix_create_note","callId":%q,"arguments":%s}`, id, args))
				return a.toolRequest(json.RawMessage(fmt.Sprintf(`%q`, id)), "item/tool/call", raw)
			}
			if !call("one", `{"title":"Plan","markdown":"body"}`) || !call("two", `{"markdown":"body","title":"Plan"}`) {
				t.Fatal("duplicate request not coalesced")
			}
			if len(a.snapshot("x").Tools) != 1 || len(peer.replies) != 0 {
				t.Fatal("duplicate approval or premature result")
			}
			r := Request{Operation: "tool_claim", ToolID: "one", RequestID: "decision"}
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if !call("three", `{"title":"Plan","markdown":"body"}`) {
				t.Fatal("claimed duplicate refused")
			}
			r.Operation, r.ToolSuccess, r.ToolResult = "tool_result", success, "Existing decision and result"
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if len(peer.replies) != 3 {
				t.Fatal("not all waiting requests received the decision")
			}
			if !call("four", `{"title":"Plan","markdown":"body"}`) || len(peer.replies) != 4 || len(a.snapshot("x").Tools) != 1 {
				t.Fatal("completed or declined action asked again")
			}
			if !call("five", `{"title":"Different plan","markdown":"body"}`) || len(a.snapshot("x").Tools) != 2 {
				t.Fatal("changed action reused permission")
			}
		})
	}
}

func TestReadAfterWriteRequiresFreshResult(t *testing.T) {
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {
		ThreadID: "thread", State: "thinking", WorkspaceAccess: true,
		Tools: []ToolCall{
			{ID: "read", Arguments: `{"operation":"read_note","itemId":"11111111-1111-4111-8111-111111111111"}`, Status: "completed", Result: "Old content"},
			{ID: "write", Arguments: `{"operation":"append_note","itemId":"11111111-1111-4111-8111-111111111111"}`, Status: "completed", Result: "Appended"},
		},
	}}}
	if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"thread","tool":"nix_read_note","callId":"fresh","arguments":{"itemId":"11111111-1111-4111-8111-111111111111"}}`)) {
		t.Fatal("fresh read refused")
	}
	if len(peer.replies) != 0 || len(a.snapshot("x").Tools) != 3 {
		t.Fatal("stale read reused after write")
	}
}

func TestToolIdentityPreservesPayloadAndNormalizesObjectKeys(t *testing.T) {
	one, _ := toolIdentity(`{"operation":"set_properties","propertiesJson":"{\"a\":1,\"b\":2}"}`)
	two, _ := toolIdentity(`{"propertiesJson":"{\"b\":2, \"a\":1}","operation":"set_properties"}`)
	if one != two {
		t.Fatal("property key order changes identity")
	}
	one, _ = toolIdentity(`{"propertiesJson":"{\"value\":9007199254740992}"}`)
	two, _ = toolIdentity(`{"propertiesJson":"{\"value\":9007199254740993}"}`)
	if one == two {
		t.Fatal("different numeric payloads share permission")
	}
}

// TestInvalidTypedToolArgumentsNeverReachApproval covers malformed typed-tool calls that a
// valid nix_<operation> tool name still reaches: an unknown parameter, a spec/blueprint that is
// not a JSON object (both refused by flattenToolCall), and a flattened call
// validateToolArguments itself refuses (an empty title, a non-UUID itemId, and so on) - the same
// two layers TestUnsupportedToolNamesAreRejectedBeforeFlattening and this test between them
// cover every rejection path toolRequest has.
func TestInvalidTypedToolArgumentsNeverReachApproval(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		tool string
		args string
	}{
		{"nix_create_note", `{"title":""}`},
		{"nix_create_note", `{"title":"Safe","url":"https://example.com"}`},
		{"nix_read_note", `{"itemId":"https://example.com"}`},
		{"nix_search", `{"query":""}`},
		{"nix_create_structured", `{"title":""}`},
		{"nix_create_structured", `{"title":"Plan","spec":[]}`},
		{"nix_create_structured", `{"title":"Plan","spec":1}`},
		{"nix_add_view", `{"itemId":"not-a-uuid","spec":{}}`},
		{"nix_create_entries", fmt.Sprintf(`{"parentId":"","spec":{"entries":[{"title":%q}]}}`, "x")},
		{"nix_add_fields", `{"itemId":"not-a-uuid","spec":{}}`},
		{"nix_add_fields", fmt.Sprintf(`{"itemId":%q,"spec":[]}`, itemID)},
		{"nix_edit_form", `{"itemId":"","spec":{}}`},
		{"nix_edit_form", fmt.Sprintf(`{"itemId":%q,"spec":1}`, itemID)},
		{"nix_set_recurrence", `{"itemId":"not-a-uuid"}`},
		{"nix_set_recurrence", fmt.Sprintf(`{"itemId":%q}`, itemID)},
		{"nix_apply_template", fmt.Sprintf(`{"templateId":%q,"title":""}`, itemID)},
	} {
		peer := &toolPeer{}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
		request := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":"bad","arguments":%s}`, tc.tool, tc.args))
		if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", request) {
			t.Fatalf("invalid call did not receive a useful failure result: %s %s", tc.tool, tc.args)
		}
		if len(a.snapshot("x").Tools) != 0 || len(peer.replies) != 1 {
			t.Fatalf("invalid request reached approval: %s %s", tc.tool, tc.args)
		}
	}
}

// TestUnsupportedToolNamesAreRejectedBeforeFlattening covers the routing gate toolRequest runs
// before flattenToolCall: nix_workspace (retired) and any name that is not one of the
// conversation mode's own typed tools are refused silently - no reply, no approval, matching how
// a tool name outside the enum was always refused before dynamicTools carried per-operation
// tools.
func TestUnsupportedToolNamesAreRejectedBeforeFlattening(t *testing.T) {
	for _, tool := range []string{"nix_workspace", "nix_read_schema", "nix_shell", "shell"} {
		peer := &toolPeer{}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
		request := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":"bad","arguments":{}}`, tool))
		if a.toolRequest(json.RawMessage(`1`), "item/tool/call", request) {
			t.Fatalf("unsupported tool name accepted: %s", tool)
		}
		if len(peer.replies) != 0 {
			t.Fatalf("unsupported tool name received a reply: %s", tool)
		}
	}
}

func TestOnlyLocalBlueprintValidationCanRunWithoutWorkspaceAccess(t *testing.T) {
	a := &account{transport: &toolPeer{}, home: t.TempDir(), conversations: map[string]*conversation{"x": {
		ThreadID: "thread", State: "thinking", Mode: "consult", WorkspaceAccess: false,
	}}}
	call := func(id, tool string) bool {
		args := `{"blueprint":{}}`
		raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":%q,"callId":%q,"arguments":%s}`, tool, id, args))
		return a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw)
	}
	if !call("local", "nix_validate_blueprint") || len(a.snapshot("x").Tools) != 1 {
		t.Fatal("local blueprint validation was refused without workspace access")
	}
	if call("workspace", "nix_build_blueprint") || len(a.snapshot("x").Tools) != 1 {
		t.Fatal("workspace write reached the approval flow without workspace access")
	}
}

func TestSpecJsonLimitsAndDepth(t *testing.T) {
	oversized := `{"operation":"create_structured","parentId":"","title":"Plan","specJson":"` + strings.Repeat("a", 24001) + `"}`
	if got := validateToolArguments(json.RawMessage(oversized), "chat"); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("oversized specJson not refused with the exact message: %q", got)
	}
	deep := strings.Repeat(`{"a":`, 25) + "1" + strings.Repeat("}", 25)
	deepArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": deep})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(deepArgs), "chat"); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("depth-25 specJson not refused with the exact message: %q", got)
	}
	atLimit := strings.Repeat(`{"a":`, 24) + "1" + strings.Repeat("}", 24)
	atLimitArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": atLimit})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(atLimitArgs), "chat"); got != "" {
		t.Fatalf("depth-24 specJson wrongly refused: %q", got)
	}
	shallow := `{"a":1}`
	if jsonDepth(shallow) != 1 {
		t.Fatalf("shallow object misjudged: %d", jsonDepth(shallow))
	}
	bracketsInString := `{"a":"{{{{[[[["}`
	if jsonDepth(bracketsInString) != 1 {
		t.Fatalf("brackets inside a string counted as nesting: %d", jsonDepth(bracketsInString))
	}
	alongsideMarkdown := `{"operation":"create_note","title":"Plan","markdown":"body","specJson":"{}"}`
	if got := validateToolArguments(json.RawMessage(alongsideMarkdown), "chat"); got != "Put markdown inside specJson entries, not alongside it." {
		t.Fatalf("markdown alongside specJson not refused: %q", got)
	}
}

func TestNewOperationsAcceptValidArguments(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, raw := range []string{
		fmt.Sprintf(`{"operation":"read_structure","itemId":%q}`, itemID),
		`{"operation":"create_structured","title":"Plan","specJson":"{\"recipe\":\"list\",\"fields\":[]}"}`,
		fmt.Sprintf(`{"operation":"add_view","itemId":%q,"specJson":"{\"views\":[]}"}`, itemID),
		fmt.Sprintf(`{"operation":"create_entries","parentId":%q,"specJson":"{\"entries\":[]}"}`, itemID),
		`{"operation":"list_templates"}`,
		fmt.Sprintf(`{"operation":"read_template","itemId":%q}`, itemID),
		fmt.Sprintf(`{"operation":"apply_template","itemId":%q,"title":"Plan"}`, itemID),
	} {
		if got := validateToolArguments(json.RawMessage(raw), "chat"); got != "" {
			t.Fatalf("valid arguments refused: %s -> %q", raw, got)
		}
	}
}

// TestConsultOnlyOperationsAreRefusedInChat covers owner decision 7 (pet-structure-consult-plan.md
// section 1.4): validate_blueprint, build_blueprint and save_as_template are refused outside
// Design mode, and accepted with minimal valid arguments in it.
func TestConsultOnlyOperationsAreRefusedInChat(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, raw := range []string{
		`{"operation":"validate_blueprint","specJson":"{}"}`,
		`{"operation":"build_blueprint","specJson":"{}"}`,
		fmt.Sprintf(`{"operation":"save_as_template","itemId":%q,"title":"Job hunt"}`, itemID),
	} {
		if got := validateToolArguments(json.RawMessage(raw), "chat"); got != "This operation is only available in Design mode." {
			t.Fatalf("consult-only operation accepted in chat: %s -> %q", raw, got)
		}
		if got := validateToolArguments(json.RawMessage(raw), "consult"); got != "" {
			t.Fatalf("consult-only operation refused in consult with valid arguments: %s -> %q", raw, got)
		}
	}
	// The empty mode ("" defaults to chat, architecture section 6) refuses them too.
	if got := validateToolArguments(json.RawMessage(`{"operation":"build_blueprint","specJson":"{}"}`), ""); got != "This operation is only available in Design mode." {
		t.Fatalf("consult-only operation accepted with an empty mode: %q", got)
	}
}

func TestConsultSaveDescriptionMatchesCaptureContract(t *testing.T) {
	tools := workspaceTools("consult")
	var saveDescription string
	for _, entry := range tools {
		tool := entry.(map[string]any)
		if tool["name"] == "nix_save_as_template" {
			saveDescription = tool["description"].(string)
		}
	}
	if saveDescription == "" {
		t.Fatal("nix_save_as_template is missing from workspaceTools(\"consult\")")
	}
	if !strings.Contains(saveDescription, "Sample:") {
		t.Fatalf("nix_save_as_template's description does not explain the Sample: exclusion: %q", saveDescription)
	}
	if !strings.Contains(consultRules, "Title every fictional sample node and sample container with the prefix Sample:") {
		t.Fatal("consult instructions omit the capture exclusion naming rule")
	}
	if !strings.Contains(consultRules, "omit spec for default sample exclusion") {
		t.Fatal("consult instructions omit how to accept nix_save_as_template's default sample exclusion")
	}
}

// TestFlattenToolCallMatchesTSReferenceFixture is the Go half of the round trip
// packages/structure-spec/src/catalog/tools.test.ts checks from the TS side: for every
// operation, catalog/tool-examples.json (generated by scripts/build-catalog.ts from
// @nix/structure-spec's TOOL_EXAMPLES and its TS reference flattenToolExample) carries a valid
// typed-tool argument object and the flat object flattening it must produce. flattenToolCall
// must produce exactly that flat object from exactly that argument object - the two languages
// checked against one fixture, so a mapping added on one side and not the other fails here.
func TestFlattenToolCallMatchesTSReferenceFixture(t *testing.T) {
	if len(toolExamples) == 0 {
		t.Fatal("catalog/tool-examples.json is empty; run pnpm --filter @nix/structure-spec catalog")
	}
	for _, fixture := range toolExamples {
		t.Run(fixture.Operation, func(t *testing.T) {
			tool := "nix_" + fixture.Operation
			flat, reason := flattenToolCall(tool, fixture.Arguments)
			if reason != "" {
				t.Fatalf("flattenToolCall refused a fixture example: %s", reason)
			}
			var got flatToolArgs
			if err := json.Unmarshal(flat, &got); err != nil {
				t.Fatalf("flattenToolCall produced invalid JSON: %v", err)
			}
			if !flatArgsEqual(got, fixture.Flat) {
				t.Fatalf("flattenToolCall(%s, %s) = %+v, want %+v", tool, fixture.Arguments, got, fixture.Flat)
			}
		})
	}
}

// flatArgsEqual compares two flatToolArgs for equal content rather than byte-identical JSON
// strings in specJson/propertiesJson: Go's json.Marshal of a map always sorts keys
// alphabetically, while the TS reference implementation's JSON.stringify preserves each
// object's own key order, so the two languages' canonical strings can differ in key order while
// still decoding to the same value. The plain string fields (operation, itemId, ...) compare
// exactly, since flattenToolCall never reorders or reformats them.
func flatArgsEqual(a, b flatToolArgs) bool {
	if a.Operation != b.Operation || a.ItemID != b.ItemID || a.ParentID != b.ParentID ||
		a.Title != b.Title || a.Markdown != b.Markdown || a.Query != b.Query {
		return false
	}
	return jsonEqual(a.PropertiesJSON, b.PropertiesJSON) && jsonEqual(a.SpecJSON, b.SpecJSON)
}

// jsonEqual reports whether two JSON strings (or two empty strings) decode to the same value,
// ignoring object key order and formatting.
func jsonEqual(a, b string) bool {
	if a == "" || b == "" {
		return a == b
	}
	var aValue, bValue any
	if json.Unmarshal([]byte(a), &aValue) != nil || json.Unmarshal([]byte(b), &bValue) != nil {
		return false
	}
	return reflect.DeepEqual(aValue, bValue)
}

// TestFlattenedFixturesAreAcceptedByValidateToolArguments proves every fixture's flattened
// result also clears the flat-shape checks validateToolArguments has always run (a nonempty
// title, a real itemId UUID, a JSON object in specJson, and so on): flattening producing the
// right shape and the flat shape being accepted are two different guarantees, and this is the
// second one.
func TestFlattenedFixturesAreAcceptedByValidateToolArguments(t *testing.T) {
	consultOnly := map[string]bool{}
	for _, operation := range consultOnlyOperations {
		consultOnly[operation] = true
	}
	for _, fixture := range toolExamples {
		t.Run(fixture.Operation, func(t *testing.T) {
			mode := "chat"
			if consultOnly[fixture.Operation] {
				mode = "consult"
			}
			encoded, err := json.Marshal(fixture.Flat)
			if err != nil {
				t.Fatal(err)
			}
			if got := validateToolArguments(json.RawMessage(encoded), mode); got != "" {
				t.Fatalf("fixture flattened result refused: %s -> %q", encoded, got)
			}
		})
	}
}

// TestUnknownOperationIsRefusedAsUnsupported proves validateToolArguments's default switch case
// still refuses an operation string outside the enum (a retired operation such as read_schema,
// or a flat shape that somehow named one flattenToolCall never produces) as unsupported, the way
// it always has.
func TestUnknownOperationIsRefusedAsUnsupported(t *testing.T) {
	for _, raw := range []string{
		`{"operation":"read_schema"}`,
		`{"operation":"shell"}`,
		`{"operation":"delete_item_permanently"}`,
		`{"operation":""}`,
	} {
		if got := validateToolArguments(json.RawMessage(raw), "chat"); got != "Unsupported workspace operation." {
			t.Fatalf("non-enum operation not refused as unsupported: %s -> %q", raw, got)
		}
	}
}

// TestFlattenToolCallRejectsUnknownParametersAndWrongShapes covers flattenToolCall's own
// refusals, independent of the fixture: a parameter no operation declares, a spec/blueprint
// argument that is not a JSON object, and an unsupported tool name.
func TestFlattenToolCallRejectsUnknownParametersAndWrongShapes(t *testing.T) {
	if _, reason := flattenToolCall("nix_create_note", json.RawMessage(`{"title":"Safe","url":"https://example.com"}`)); reason == "" {
		t.Fatal("unknown parameter accepted")
	} else if !strings.Contains(reason, "url") || !strings.Contains(reason, "nix_create_note") {
		t.Fatalf("unknown parameter reason does not name the key and the tool: %q", reason)
	}
	if _, reason := flattenToolCall("nix_create_structured", json.RawMessage(`{"title":"Plan","spec":[]}`)); reason == "" {
		t.Fatal("array spec accepted")
	}
	if _, reason := flattenToolCall("nix_create_structured", json.RawMessage(`{"title":"Plan","spec":1}`)); reason == "" {
		t.Fatal("scalar spec accepted")
	}
	if _, reason := flattenToolCall("nix_read_schema", json.RawMessage(`{}`)); reason == "" {
		t.Fatal("unsupported tool name accepted")
	}
	if _, reason := flattenToolCall("nix_read_item", json.RawMessage(`not json`)); reason == "" {
		t.Fatal("non-JSON arguments accepted")
	}
}

// TestFlattenToolCallMapsTemplateIdToItemId covers L1.1's one deliberate naming difference
// between a typed tool and the flat shape: nix_read_template and nix_apply_template take
// templateId, which flattens to the flat shape's itemId field (the id run.ts's apply_template
// and read_template branches have always read).
func TestFlattenToolCallMapsTemplateIdToItemId(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		tool string
		args string
	}{
		{"nix_read_template", fmt.Sprintf(`{"templateId":%q}`, itemID)},
		{"nix_apply_template", fmt.Sprintf(`{"templateId":%q,"title":"Plan"}`, itemID)},
	} {
		flat, reason := flattenToolCall(tc.tool, json.RawMessage(tc.args))
		if reason != "" {
			t.Fatalf("%s: %s", tc.tool, reason)
		}
		var got flatToolArgs
		if err := json.Unmarshal(flat, &got); err != nil {
			t.Fatal(err)
		}
		if got.ItemID != itemID {
			t.Fatalf("%s: templateId did not map to itemId: %+v", tc.tool, got)
		}
	}
}

func TestReadSchemaIsNoLongerAnOperation(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	got := validateToolArguments(json.RawMessage(fmt.Sprintf(`{"operation":"read_schema","itemId":%q}`, itemID)), "chat")
	if got != "Unsupported workspace operation." {
		t.Fatalf("read_schema still accepted: %q", got)
	}
}

func TestSpecJsonIdentityIsCanonical(t *testing.T) {
	one, _ := toolIdentity(`{"operation":"create_structured","specJson":"{\"a\":1,\"b\":2}"}`)
	two, _ := toolIdentity(`{"specJson":"{\"b\":2, \"a\":1}","operation":"create_structured"}`)
	if one != two {
		t.Fatal("specJson key order changes identity")
	}
}

func TestNewReadOperationsAreReadOnly(t *testing.T) {
	for _, raw := range []string{
		`{"operation":"read_structure","itemId":"11111111-1111-4111-8111-111111111111"}`,
		`{"operation":"list_templates"}`,
		`{"operation":"read_template","itemId":"11111111-1111-4111-8111-111111111111"}`,
		`{"operation":"validate_blueprint"}`,
	} {
		_, readOnly := toolIdentity(raw)
		if !readOnly {
			t.Fatalf("operation not marked read-only: %s", raw)
		}
	}
	for _, raw := range []string{
		`{"operation":"create_structured"}`,
		`{"operation":"add_view"}`,
		`{"operation":"create_entries"}`,
		`{"operation":"add_fields"}`,
		`{"operation":"edit_form"}`,
		`{"operation":"set_recurrence"}`,
		`{"operation":"apply_template"}`,
		`{"operation":"build_blueprint"}`,
		`{"operation":"save_as_template"}`,
	} {
		_, readOnly := toolIdentity(raw)
		if readOnly {
			t.Fatalf("write operation marked read-only: %s", raw)
		}
	}
}

func TestChatCatalogIsEmbeddedAndBounded(t *testing.T) {
	if chatCatalog == "" {
		t.Fatal("chat catalog is empty")
	}
	if len(chatCatalog) > 3000 {
		t.Fatalf("chat catalog exceeds the 3000 byte budget: %d", len(chatCatalog))
	}
	for _, word := range []string{"Property types", "View kinds", "Recipes", "Never"} {
		if !strings.Contains(chatCatalog, word) {
			t.Fatalf("chat catalog missing section %q", word)
		}
	}
}

func (p *toolPeer) SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool) {}
func (p *toolPeer) Reply(_ json.RawMessage, result any) error {
	p.replies = append(p.replies, result)
	return nil
}

func TestToolApprovalClaimAndResult(t *testing.T) {
	peer := &toolPeer{}
	a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{}, status: "connected"}
	r := request()
	r.WorkspaceAccess = true
	if _, err := a.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"threadId":"provider-thread","tool":"nix_create_note","callId":"tool-1","arguments":{"title":"Plan"}}`)
	if !a.toolRequest(json.RawMessage(`71`), "item/tool/call", raw) {
		t.Fatal("valid tool request refused")
	}
	key := r.WorkspaceID + "-" + r.PetID
	if len(peer.replies) != 0 || a.snapshot(key).Tools[0].Status != "pending" {
		t.Fatal("executed without approval")
	}
	r.Operation = "tool_result"
	r.ToolID = "tool-1"
	r.ToolResult = "created"
	r.ToolSuccess = true
	if a.resolveTool(key, r) == nil {
		t.Fatal("unclaimed result accepted")
	}
	r.Operation = "tool_claim"
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if a.resolveTool(key, r) == nil {
		t.Fatal("duplicate claim accepted")
	}
	r.Operation = "tool_result"
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if err := a.resolveTool(key, r); err != nil {
		t.Fatal(err)
	}
	if len(peer.replies) != 1 || a.snapshot(key).Tools[0].Status != "completed" {
		t.Fatal("result was not delivered exactly once")
	}
	restored := &account{home: a.home, conversations: map[string]*conversation{}}
	if err := restored.load(key); err != nil {
		t.Fatal(err)
	}
	if restored.snapshot(key).Tools[0].Status != "completed" {
		t.Fatal("receipt lost after restart")
	}
}

func TestToolsRequireWorkspaceConsentAndCorrectConversation(t *testing.T) {
	a := &account{transport: &toolPeer{}, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking"}}}
	raw := json.RawMessage(`{"threadId":"thread","tool":"nix_list_items","callId":"one","arguments":{}}`)
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) {
		t.Fatal("workspace tool accepted without consent")
	}
	a.conversations["x"].WorkspaceAccess = true
	if a.toolRequest(json.RawMessage(`1`), "item/commandExecution/requestApproval", raw) {
		t.Fatal("host tool accepted")
	}
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"other","tool":"nix_list_items","callId":"one","arguments":{}}`)) {
		t.Fatal("foreign thread tool accepted")
	}
}

func TestCompletedOrInterruptedTurnCannotLeaveExecutableApproval(t *testing.T) {
	for _, status := range []string{"completed", "interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			peer := &toolPeer{}
			a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", Tools: []ToolCall{{ID: "pending", Status: "pending", rpcID: json.RawMessage(`1`)}}}}}
			a.notify("turn/completed", json.RawMessage(fmt.Sprintf(`{"threadId":"thread","turn":{"status":%q}}`, status)))
			if err := a.resolveTool("x", Request{Operation: "tool_claim", ToolID: "pending", RequestID: "late"}); err == nil {
				t.Fatal("stale approval can still execute")
			}
			if a.snapshot("x").Tools[0].Status != "interrupted" {
				t.Fatal("ended turn still offers an approval")
			}
		})
	}
}

func TestUnfinishedToolCannotBeReexecutedAfterRestart(t *testing.T) {
	a := &account{home: t.TempDir(), conversations: map[string]*conversation{"x": {Tools: []ToolCall{{ID: "one", Status: "claimed", ClaimID: "old"}}}}}
	if err := a.saveLocked("x"); err != nil {
		t.Fatal(err)
	}
	restored := &account{home: a.home, conversations: map[string]*conversation{}}
	if err := restored.load("x"); err != nil {
		t.Fatal(err)
	}
	if restored.snapshot("x").Tools[0].Status != "interrupted" {
		t.Fatal("unfinished write can be repeated")
	}
}
