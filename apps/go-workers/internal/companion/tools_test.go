package companion

import (
	"context"
	"encoding/json"
	"fmt"
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
	for _, raw := range []string{`{"operation":"read_schema"}`, `{"operation":"shell"}`, `{"operation":"create_note","title":""}`, `{"operation":"create_note","title":"Safe","url":"https://example.com"}`, `{"operation":"read_note","itemId":"https://example.com"}`, `{"operation":"search","query":""}`} {
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
