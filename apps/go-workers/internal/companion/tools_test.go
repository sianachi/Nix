package companion

import (
	"context"
	"encoding/json"
	"fmt"
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
				raw := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":"nix_workspace","callId":%q,"arguments":%s}`, id, args))
				return a.toolRequest(json.RawMessage(fmt.Sprintf(`%q`, id)), "item/tool/call", raw)
			}
			if !call("one", `{"operation":"create_note","title":"Plan"}`) || !call("two", `{"title":"Plan","operation":"create_note"}`) {
				t.Fatal("duplicate request not coalesced")
			}
			if len(a.snapshot("x").Tools) != 1 || len(peer.replies) != 0 {
				t.Fatal("duplicate approval or premature result")
			}
			r := Request{Operation: "tool_claim", ToolID: "one", RequestID: "decision"}
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if !call("three", `{"operation":"create_note","title":"Plan"}`) {
				t.Fatal("claimed duplicate refused")
			}
			r.Operation, r.ToolSuccess, r.ToolResult = "tool_result", success, "Existing decision and result"
			if err := a.resolveTool("x", r); err != nil {
				t.Fatal(err)
			}
			if len(peer.replies) != 3 {
				t.Fatal("not all waiting requests received the decision")
			}
			if !call("four", `{"operation":"create_note","title":"Plan"}`) || len(peer.replies) != 4 || len(a.snapshot("x").Tools) != 1 {
				t.Fatal("completed or declined action asked again")
			}
			if !call("five", `{"operation":"create_note","title":"Different plan"}`) || len(a.snapshot("x").Tools) != 2 {
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
	if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"thread","tool":"nix_workspace","callId":"fresh","arguments":{"operation":"read_note","itemId":"11111111-1111-4111-8111-111111111111"}}`)) {
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

func TestInvalidToolArgumentsNeverReachApproval(t *testing.T) {
	for _, raw := range []string{
		`{"operation":"read_schema"}`,
		`{"operation":"shell"}`,
		`{"operation":"create_note","title":""}`,
		`{"operation":"create_note","title":"Safe","url":"https://example.com"}`,
		`{"operation":"read_note","itemId":"https://example.com"}`,
		`{"operation":"search","query":""}`,
		`{"operation":"create_structured","title":""}`,
		`{"operation":"create_structured","title":"Plan","specJson":"[]"}`,
		`{"operation":"create_structured","title":"Plan","specJson":"1"}`,
		`{"operation":"add_view","itemId":"not-a-uuid","specJson":"{}"}`,
		`{"operation":"create_entries","parentId":"","specJson":"{}"}`,
		`{"operation":"add_fields","itemId":"not-a-uuid","specJson":"{}"}`,
		`{"operation":"add_fields","itemId":"11111111-1111-4111-8111-111111111111","specJson":"[]"}`,
		`{"operation":"edit_form","itemId":"","specJson":"{}"}`,
		`{"operation":"edit_form","itemId":"11111111-1111-4111-8111-111111111111","specJson":"1"}`,
		`{"operation":"set_recurrence","itemId":"not-a-uuid","specJson":"{}"}`,
		`{"operation":"set_recurrence","itemId":"11111111-1111-4111-8111-111111111111","specJson":""}`,
		`{"operation":"apply_template","itemId":"11111111-1111-4111-8111-111111111111","title":""}`,
	} {
		peer := &toolPeer{}
		a := &account{transport: peer, home: t.TempDir(), conversations: map[string]*conversation{"x": {ThreadID: "thread", State: "thinking", WorkspaceAccess: true}}}
		request := json.RawMessage(fmt.Sprintf(`{"threadId":"thread","tool":"nix_workspace","callId":"bad","arguments":%s}`, raw))
		if !a.toolRequest(json.RawMessage(`1`), "item/tool/call", request) {
			t.Fatal("invalid call did not receive a useful failure result")
		}
		if len(a.snapshot("x").Tools) != 0 || len(peer.replies) != 1 {
			t.Fatalf("invalid request reached approval: %s", raw)
		}
	}
}

func TestSpecJsonLimitsAndDepth(t *testing.T) {
	oversized := `{"operation":"create_structured","parentId":"","title":"Plan","specJson":"` + strings.Repeat("a", 24001) + `"}`
	if got := validateToolArguments(json.RawMessage(oversized)); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("oversized specJson not refused with the exact message: %q", got)
	}
	deep := strings.Repeat(`{"a":`, 25) + "1" + strings.Repeat("}", 25)
	deepArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": deep})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(deepArgs)); got != "The design is too large. Use fewer items and fields." {
		t.Fatalf("depth-25 specJson not refused with the exact message: %q", got)
	}
	atLimit := strings.Repeat(`{"a":`, 24) + "1" + strings.Repeat("}", 24)
	atLimitArgs, err := json.Marshal(map[string]string{"operation": "create_structured", "parentId": "", "title": "Plan", "specJson": atLimit})
	if err != nil {
		t.Fatal(err)
	}
	if got := validateToolArguments(json.RawMessage(atLimitArgs)); got != "" {
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
	if got := validateToolArguments(json.RawMessage(alongsideMarkdown)); got != "Put markdown inside specJson entries, not alongside it." {
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
		if got := validateToolArguments(json.RawMessage(raw)); got != "" {
			t.Fatalf("valid arguments refused: %s -> %q", raw, got)
		}
	}
}

// TestEnumAndValidatorAgree proves the operation enum in workspaceTools() and the switch in
// validateToolArguments never drift apart: every enum entry must have a minimal valid argument
// set below that validateToolArguments accepts, and any string outside the enum (including a
// retired operation such as read_schema) must be refused as unsupported.
func TestEnumAndValidatorAgree(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	minimalArguments := map[string]string{
		"list_items":        `{"operation":"list_items"}`,
		"search":            `{"operation":"search","query":"a"}`,
		"read_item":         fmt.Sprintf(`{"operation":"read_item","itemId":%q}`, itemID),
		"read_note":         fmt.Sprintf(`{"operation":"read_note","itemId":%q}`, itemID),
		"read_structure":    fmt.Sprintf(`{"operation":"read_structure","itemId":%q}`, itemID),
		"create_note":       `{"operation":"create_note","title":"Plan"}`,
		"append_note":       fmt.Sprintf(`{"operation":"append_note","itemId":%q,"markdown":"more"}`, itemID),
		"rename_item":       fmt.Sprintf(`{"operation":"rename_item","itemId":%q,"title":"Plan"}`, itemID),
		"move_item":         fmt.Sprintf(`{"operation":"move_item","itemId":%q}`, itemID),
		"set_properties":    fmt.Sprintf(`{"operation":"set_properties","itemId":%q,"propertiesJson":"{}"}`, itemID),
		"trash_item":        fmt.Sprintf(`{"operation":"trash_item","itemId":%q}`, itemID),
		"restore_item":      fmt.Sprintf(`{"operation":"restore_item","itemId":%q}`, itemID),
		"create_structured": `{"operation":"create_structured","title":"Plan","specJson":"{}"}`,
		"add_view":          fmt.Sprintf(`{"operation":"add_view","itemId":%q,"specJson":"{}"}`, itemID),
		"create_entries":    fmt.Sprintf(`{"operation":"create_entries","parentId":%q,"specJson":"{}"}`, itemID),
		"add_fields":        fmt.Sprintf(`{"operation":"add_fields","itemId":%q,"specJson":"{}"}`, itemID),
		"edit_form":         fmt.Sprintf(`{"operation":"edit_form","itemId":%q,"specJson":"{}"}`, itemID),
		"set_recurrence":    fmt.Sprintf(`{"operation":"set_recurrence","itemId":%q,"specJson":"{}"}`, itemID),
		"list_templates":    `{"operation":"list_templates"}`,
		"read_template":     fmt.Sprintf(`{"operation":"read_template","itemId":%q}`, itemID),
		"apply_template":    fmt.Sprintf(`{"operation":"apply_template","itemId":%q,"title":"Plan"}`, itemID),
	}

	enum := workspaceOperationEnum(t)
	if len(enum) != len(minimalArguments) {
		t.Fatalf("workspaceTools() enum has %d operations, minimalArguments covers %d; the fixture is stale", len(enum), len(minimalArguments))
	}
	for _, operation := range enum {
		raw, ok := minimalArguments[operation]
		if !ok {
			t.Fatalf("no minimal arguments fixture for enum operation %q", operation)
		}
		if got := validateToolArguments(json.RawMessage(raw)); got != "" {
			t.Fatalf("enum operation %q refused with minimal valid arguments: %s -> %q", operation, raw, got)
		}
	}

	for _, raw := range []string{
		`{"operation":"read_schema"}`,
		`{"operation":"shell"}`,
		`{"operation":"delete_item_permanently"}`,
		`{"operation":""}`,
	} {
		if got := validateToolArguments(json.RawMessage(raw)); got != "Unsupported workspace operation." {
			t.Fatalf("non-enum operation not refused as unsupported: %s -> %q", raw, got)
		}
	}
}

func TestReadSchemaIsNoLongerAnOperation(t *testing.T) {
	itemID := "11111111-1111-4111-8111-111111111111"
	got := validateToolArguments(json.RawMessage(fmt.Sprintf(`{"operation":"read_schema","itemId":%q}`, itemID)))
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
	raw := json.RawMessage(`{"threadId":"provider-thread","tool":"nix_workspace","callId":"tool-1","arguments":{"operation":"create_note","title":"Plan"}}`)
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
	raw := json.RawMessage(`{"threadId":"thread","tool":"nix_workspace","callId":"one","arguments":{}}`)
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", raw) {
		t.Fatal("workspace tool accepted without consent")
	}
	a.conversations["x"].WorkspaceAccess = true
	if a.toolRequest(json.RawMessage(`1`), "item/commandExecution/requestApproval", raw) {
		t.Fatal("host tool accepted")
	}
	if a.toolRequest(json.RawMessage(`1`), "item/tool/call", json.RawMessage(`{"threadId":"other","tool":"nix_workspace","callId":"one","arguments":{}}`)) {
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
