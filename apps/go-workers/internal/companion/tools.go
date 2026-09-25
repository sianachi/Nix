package companion

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

type Model struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Default bool   `json:"default"`
}

// ToolCall is a private, per-conversation approval receipt, not authorization.
// Only the user's ordinary Nix client executes tools; Core still authorizes every API call.
type ToolCall struct {
	ID        string `json:"id"`
	Arguments string `json:"arguments"`
	Status    string `json:"status"`
	Result    string `json:"result"`
	ClaimID   string `json:"claimId"`
	rpcID     json.RawMessage
	waiters   []json.RawMessage
}

type toolTransport interface {
	SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool)
	Reply(json.RawMessage, any) error
}

func workspaceTools() []any {
	properties := map[string]any{}
	for _, key := range []string{"itemId", "parentId", "title", "markdown", "query", "propertiesJson", "specJson"} {
		properties[key] = map[string]string{"type": "string"}
	}
	properties["operation"] = map[string]any{"type": "string", "enum": []string{"list_items", "search", "read_item", "read_note", "read_structure", "create_note", "append_note", "rename_item", "move_item", "set_properties", "trash_item", "restore_item", "create_structured", "add_view", "create_entries", "list_templates", "read_template", "apply_template"}}
	return []any{map[string]any{"type": "function", "name": "nix_workspace", "description": "Work in the current Nix workspace. Every call is shown for approval. Supply empty strings for unused fields. Reads: list_items (parentId, empty for roots); search (query); read_item, read_note and read_structure (itemId; read_structure returns fields, views and child count); list_templates (optional query); read_template (itemId is the template id). Writes: create_note (title, markdown, optional parentId); append_note (itemId, markdown; never replaces content); rename_item (itemId, title); move_item (itemId, parentId); set_properties (itemId, propertiesJson; read_structure first); trash_item is recoverable; restore_item. Structure: create_structured (parentId, title, specJson {recipe, fields, views}); add_view (itemId, specJson {fields, views}); create_entries (parentId, specJson {entries}); apply_template (itemId is the template id, parentId, title, specJson {inputs}). specJson is a JSON string; the field types, view kinds and their requirements are in your instructions. Not available: publishing, permanent deletion, removing or retyping fields, deleting views, workspace administration.", "inputSchema": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"operation", "itemId", "parentId", "title", "markdown", "query", "propertiesJson", "specJson"}, "properties": properties}}}
}

func (a *account) listModels(ctx context.Context) error {
	raw, err := a.transport.Call(ctx, "model/list", map[string]any{"limit": 100, "includeHidden": false})
	if err != nil {
		return err
	}
	var page struct {
		Data []struct {
			Model       string `json:"model"`
			DisplayName string `json:"displayName"`
			IsDefault   bool   `json:"isDefault"`
		} `json:"data"`
	}
	if len(raw) > 256<<10 || json.Unmarshal(raw, &page) != nil || len(page.Data) > 100 {
		return errors.New("invalid model catalog")
	}
	models := []Model{}
	for _, entry := range page.Data {
		if entry.Model != "" && len(entry.Model) <= 160 && len(entry.DisplayName) <= 200 {
			models = append(models, Model{entry.Model, entry.DisplayName, entry.IsDefault})
		}
	}
	a.mu.Lock()
	a.models = models
	a.mu.Unlock()
	return nil
}

func (a *account) toolRequest(id json.RawMessage, method string, raw json.RawMessage) bool {
	if method != "item/tool/call" || len(raw) > 40000 {
		return false
	}
	var p struct {
		ThreadID  string          `json:"threadId"`
		Tool      string          `json:"tool"`
		CallID    string          `json:"callId"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Tool != "nix_workspace" || p.CallID == "" || len(p.CallID) > 200 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, c := range a.conversations {
		if c.ThreadID != p.ThreadID || c.State != "thinking" || !c.WorkspaceAccess {
			continue
		}
		if reason := validateToolArguments(p.Arguments); reason != "" {
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason+" No action ran and no approval was requested."))
				return true
			}
			return false
		}
		fingerprint, readOnly := toolIdentity(string(p.Arguments))
		readMayBeStale := false
		for i := len(c.Tools) - 1; i >= 0; i-- {
			t := &c.Tools[i]
			previous, previousReadOnly := toolIdentity(t.Arguments)
			if t.ID == p.CallID || fingerprint != "" && previous == fingerprint {
				// The same provider ID must never be repurposed for a different action.
				if fingerprint == "" || previous != fingerprint {
					return false
				}
				if t.ID != p.CallID && readOnly && readMayBeStale && t.Status == "completed" {
					continue
				}
				if t.Status == "pending" || t.Status == "claimed" {
					if string(t.rpcID) == string(id) {
						return true
					}
					for _, waiter := range t.waiters {
						if string(waiter) == string(id) {
							return true
						}
					}
					if len(t.waiters) >= 20 {
						return false
					}
					t.waiters = append(t.waiters, append(json.RawMessage{}, id...))
					return true
				}
				if peer, ok := a.transport.(toolTransport); ok {
					_ = peer.Reply(id, toolOutput(t.Status == "completed", t.Result))
					return true
				}
				return false
			}
			// A read after a write needs fresh data, not a cached pre-write result.
			if !previousReadOnly {
				readMayBeStale = true
			}
		}
		if len(c.Tools) >= 20 {
			return false
		}
		c.Tools = append(c.Tools, ToolCall{ID: p.CallID, Arguments: string(p.Arguments), Status: "pending", rpcID: append(json.RawMessage{}, id...)})
		if a.saveLocked(key) != nil {
			c.Tools = c.Tools[:len(c.Tools)-1]
			return false
		}
		return true
	}
	return false
}

// Identity is scoped to one user turn and includes every argument. Canonical JSON
// handles reordered keys without treating a changed target or payload as approved.
func toolIdentity(raw string) (string, bool) {
	var args map[string]any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if !json.Valid([]byte(raw)) || decoder.Decode(&args) != nil || args == nil {
		return "", false
	}
	operation, _ := args["operation"].(string)
	readOnly := operation == "list_items" || operation == "search" || operation == "read_item" || operation == "read_note" || operation == "read_structure" || operation == "list_templates" || operation == "read_template"
	if properties, ok := args["propertiesJson"].(string); ok && properties != "" {
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(properties))
		decoder.UseNumber()
		if json.Valid([]byte(properties)) && decoder.Decode(&object) == nil && object != nil {
			canonical, _ := json.Marshal(object)
			args["propertiesJson"] = string(canonical)
		}
	}
	if spec, ok := args["specJson"].(string); ok && spec != "" {
		var object map[string]any
		decoder := json.NewDecoder(strings.NewReader(spec))
		decoder.UseNumber()
		if json.Valid([]byte(spec)) && decoder.Decode(&object) == nil && object != nil {
			canonical, _ := json.Marshal(object)
			args["specJson"] = string(canonical)
		}
	}
	canonical, err := json.Marshal(args)
	if err != nil {
		return "", false
	}
	return string(canonical), readOnly
}

func toolOutput(success bool, result string) any {
	return map[string]any{"success": success, "contentItems": []any{map[string]string{"type": "inputText", "text": result}}}
}

func validateToolArguments(raw json.RawMessage) string {
	var p struct {
		Operation  string `json:"operation"`
		ItemID     string `json:"itemId"`
		ParentID   string `json:"parentId"`
		Title      string `json:"title"`
		Markdown   string `json:"markdown"`
		Query      string `json:"query"`
		Properties string `json:"propertiesJson"`
		Spec       string `json:"specJson"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&p) != nil {
		return "Tool arguments must be a JSON object with string fields."
	}
	if len(p.Title) > 240 || len(p.Markdown) > 16000 || len(p.Query) > 240 || len(p.Properties) > 8000 {
		return "Tool arguments exceed the supported size limit."
	}
	if len(p.Spec) > 24000 {
		return "The design is too large. Use fewer items and fields."
	}
	if p.Spec != "" && p.Markdown != "" {
		return "Put markdown inside specJson entries, not alongside it."
	}
	if p.Spec != "" && jsonDepth(p.Spec) > 24 {
		return "The design is too large. Use fewer items and fields."
	}
	if p.ParentID != "" && !uuid.MatchString(p.ParentID) {
		return "parentId must be a Nix item UUID or empty for the workspace root."
	}
	if p.ItemID != "" && !uuid.MatchString(p.ItemID) {
		return "itemId must be a Nix item UUID."
	}
	switch p.Operation {
	case "list_items":
	case "search":
		if strings.TrimSpace(p.Query) == "" {
			return "search requires a nonempty query."
		}
	case "list_templates":
	case "create_note":
		if strings.TrimSpace(p.Title) == "" {
			return "create_note requires a title."
		}
	case "read_item", "read_note", "read_structure", "append_note", "rename_item", "move_item", "set_properties", "trash_item", "restore_item", "read_template":
		if !uuid.MatchString(p.ItemID) {
			return "This operation requires the exact itemId UUID. Discover it with list_items or search if it is not already known."
		}
		if p.Operation == "rename_item" && strings.TrimSpace(p.Title) == "" {
			return "rename_item requires a title."
		}
		if p.Operation == "append_note" && strings.TrimSpace(p.Markdown) == "" {
			return "append_note requires nonempty markdown."
		}
		if p.Operation == "set_properties" {
			var object map[string]json.RawMessage
			if json.Unmarshal([]byte(p.Properties), &object) != nil || object == nil {
				return "set_properties requires a JSON object in propertiesJson."
			}
		}
	case "create_structured":
		if strings.TrimSpace(p.Title) == "" {
			return "create_structured requires a title."
		}
		if !isJSONObject(p.Spec) {
			return "create_structured requires a JSON object in specJson."
		}
	case "add_view":
		if !uuid.MatchString(p.ItemID) {
			return "This operation requires the exact itemId UUID. Discover it with list_items or search if it is not already known."
		}
		if !isJSONObject(p.Spec) {
			return "add_view requires a JSON object in specJson."
		}
	case "create_entries":
		if !uuid.MatchString(p.ParentID) {
			return "create_entries requires the exact parentId UUID. Discover it with list_items or search if it is not already known."
		}
		if !isJSONObject(p.Spec) {
			return "create_entries requires a JSON object in specJson."
		}
	case "apply_template":
		if !uuid.MatchString(p.ItemID) {
			return "This operation requires the exact itemId UUID. Discover it with list_items or search if it is not already known."
		}
		if strings.TrimSpace(p.Title) == "" {
			return "apply_template requires a title."
		}
		if p.Spec != "" && !isJSONObject(p.Spec) {
			return "apply_template requires a JSON object in specJson when supplied."
		}
	default:
		return "Unsupported workspace operation."
	}
	return ""
}

// isJSONObject reports whether raw decodes as a JSON object (not an array, scalar or
// empty string).
func isJSONObject(raw string) bool {
	var object map[string]json.RawMessage
	return raw != "" && json.Unmarshal([]byte(raw), &object) == nil && object != nil
}

// jsonDepth counts the maximum nesting of '{' and '[' in raw, ignoring anything inside a
// JSON string, without decoding the document. Used to bound specJson before it is parsed.
func jsonDepth(raw string) int {
	depth, maxDepth := 0, 0
	inString, escaped := false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > maxDepth {
				maxDepth = depth
			}
		case '}', ']':
			depth--
		}
	}
	return maxDepth
}

func (a *account) resolveTool(key string, r Request) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversations[key]
	for i := range c.Tools {
		t := &c.Tools[i]
		if t.ID != r.ToolID {
			continue
		}
		if r.Operation == "tool_claim" {
			if c.State != "thinking" || t.Status != "pending" {
				return errors.New("tool already claimed; do not execute again")
			}
			t.Status = "claimed"
			t.ClaimID = r.RequestID
			return a.saveLocked(key)
		}
		if t.ClaimID != r.RequestID {
			return errors.New("tool claim does not match")
		}
		if t.Status == "completed" || t.Status == "failed" {
			return nil
		}
		if t.Status != "claimed" || len(t.rpcID) == 0 {
			return errors.New("tool is no longer active")
		}
		peer, ok := a.transport.(toolTransport)
		if !ok {
			return errors.New("tool transport unavailable")
		}
		t.Result = strings.TrimSpace(r.ToolResult)
		if t.Result == "" {
			t.Result = "No result supplied. Do not assume the operation succeeded."
		}
		t.Status = "failed"
		if r.ToolSuccess {
			t.Status = "completed"
		}
		if err := a.saveLocked(key); err != nil {
			return err
		}
		var replyErr error
		for _, id := range append([]json.RawMessage{t.rpcID}, t.waiters...) {
			if err := peer.Reply(id, toolOutput(r.ToolSuccess, t.Result)); err != nil {
				replyErr = err
			}
		}
		t.waiters = nil
		return replyErr
	}
	return errors.New("unknown tool call")
}

func (a *account) cancelTools(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelToolsLocked(key)
	_ = a.saveLocked(key)
}

func (a *account) cancelToolsLocked(key string) {
	peer, ok := a.transport.(toolTransport)
	for i := range a.conversations[key].Tools {
		t := &a.conversations[key].Tools[i]
		if t.Status == "pending" || t.Status == "claimed" {
			t.Result = "The turn ended before this request was confirmed. A claimed write may have completed; inspect Nix before retrying."
			for _, id := range append([]json.RawMessage{t.rpcID}, t.waiters...) {
				if ok && len(id) > 0 {
					_ = peer.Reply(id, toolOutput(false, t.Result))
				}
			}
			t.waiters = nil
			t.Status = "interrupted"
		}
	}
}
