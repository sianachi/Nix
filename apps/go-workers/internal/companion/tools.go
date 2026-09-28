package companion

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"
)

type Model struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Default bool   `json:"default"`
	// supportedEfforts and defaultEffort come from model/list's own
	// supportedReasoningEfforts[].reasoningEffort and defaultReasoningEffort (Codex 0.153.4);
	// json:"-" keeps the wire Model shape (what the web client already reads) unchanged.
	// effortFor uses these to decide whether a configured NIX_COMPANION_*_EFFORT value is one
	// this model actually advertises before sending it on turn/start.
	supportedEfforts []string `json:"-"`
	defaultEffort    string   `json:"-"`
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
	// pendingSince and claimedAt feed the per-turn timing log and tool events only.
	pendingSince time.Time
	claimedAt    time.Time
	waiters      []json.RawMessage
}

type toolTransport interface {
	SetRequestHandler(func(json.RawMessage, string, json.RawMessage) bool)
	Reply(json.RawMessage, any) error
}

// flatToolArgs is the flat shape `@nix/companion`'s workspaceToolSchema and run.ts have always
// parsed, and the shape `ToolCall.Arguments` stores. flattenToolCall builds one from a typed
// nix_<operation> call's native-JSON arguments.
type flatToolArgs struct {
	Operation      string `json:"operation"`
	ItemID         string `json:"itemId"`
	ParentID       string `json:"parentId"`
	Title          string `json:"title"`
	Markdown       string `json:"markdown"`
	Query          string `json:"query"`
	PropertiesJSON string `json:"propertiesJson"`
	SpecJSON       string `json:"specJson"`
}

// argKind says how one typed argument maps onto the flat shape.
type argKind int

const (
	argString     argKind = iota // copied verbatim into a flat string field
	argObjectJSON                // must be a JSON object; marshaled to a canonical JSON string
)

// argMapping names one typed argument's flat field and kind.
type argMapping struct {
	flat string
	kind argKind
}

// toolArgSpecs mirrors packages/structure-spec/src/catalog/tools.ts's TOOL_BUILDS mapping table
// exactly (L1.1): which native-JSON arguments each nix_<operation> tool accepts, and which flat
// field each maps onto. Every "spec"/"blueprint"/"properties" argument marshals to specJson or
// propertiesJson; templateId maps to itemId, not a separate flat field, matching how run.ts
// already reads a template id (apply_template's itemId, read_template's itemId).
var toolArgSpecs = map[string]map[string]argMapping{
	"list_items":         {"parentId": {"parentId", argString}},
	"search":             {"query": {"query", argString}},
	"read_item":          {"itemId": {"itemId", argString}},
	"read_note":          {"itemId": {"itemId", argString}},
	"read_structure":     {"itemId": {"itemId", argString}},
	"create_note":        {"title": {"title", argString}, "markdown": {"markdown", argString}, "parentId": {"parentId", argString}},
	"append_note":        {"itemId": {"itemId", argString}, "markdown": {"markdown", argString}},
	"rename_item":        {"itemId": {"itemId", argString}, "title": {"title", argString}},
	"move_item":          {"itemId": {"itemId", argString}, "parentId": {"parentId", argString}},
	"set_properties":     {"itemId": {"itemId", argString}, "properties": {"propertiesJson", argObjectJSON}},
	"trash_item":         {"itemId": {"itemId", argString}},
	"restore_item":       {"itemId": {"itemId", argString}},
	"create_structured":  {"title": {"title", argString}, "spec": {"specJson", argObjectJSON}, "parentId": {"parentId", argString}},
	"add_view":           {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"create_entries":     {"parentId": {"parentId", argString}, "spec": {"specJson", argObjectJSON}},
	"validate_blueprint": {"blueprint": {"specJson", argObjectJSON}},
	"add_fields":         {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"edit_form":          {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"set_recurrence":     {"itemId": {"itemId", argString}, "spec": {"specJson", argObjectJSON}},
	"list_templates":     {"query": {"query", argString}},
	"read_template":      {"templateId": {"itemId", argString}},
	"apply_template":     {"templateId": {"itemId", argString}, "title": {"title", argString}, "parentId": {"parentId", argString}, "spec": {"specJson", argObjectJSON}},
	"build_blueprint":    {"blueprint": {"specJson", argObjectJSON}, "parentId": {"parentId", argString}},
	"save_as_template":   {"itemId": {"itemId", argString}, "title": {"title", argString}, "spec": {"specJson", argObjectJSON}},
}

// flattenToolCall translates one typed nix_<operation> call's native-JSON arguments into the
// flat {operation, itemId, parentId, title, markdown, query, propertiesJson, specJson} shape
// @nix/companion/run.ts has always parsed, so Core, the OpenAPI contract, @nix/companion, nixctl
// and the web executor stay unchanged (L1 goal). tool must already be one of the conversation
// mode's tool names (toolRequest checks that before calling this). On success it returns the flat
// arguments, marshaled, and an empty reason; on a malformed call it returns nil and a
// model-readable reason naming the offending key and tool, to be sent back exactly like a
// validateToolArguments failure ("No action ran and no approval was requested.").
func flattenToolCall(tool string, raw json.RawMessage) (json.RawMessage, string) {
	operation := operationFromToolName(tool)
	spec, ok := toolArgSpecs[operation]
	if !ok {
		return nil, fmt.Sprintf("%s is not a supported tool.", tool)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, fmt.Sprintf("%s requires a JSON object of arguments.", tool)
	}
	flat := flatToolArgs{Operation: operation}
	for key, value := range fields {
		mapping, known := spec[key]
		if !known {
			return nil, fmt.Sprintf("%q is not a parameter of %s; it accepts %s.", key, tool, strings.Join(acceptedParams(spec), ", "))
		}
		switch mapping.kind {
		case argString:
			var text string
			if json.Unmarshal(value, &text) != nil {
				return nil, fmt.Sprintf("%s.%s must be a string.", tool, key)
			}
			if err := setFlatString(&flat, mapping.flat, text); err != nil {
				return nil, fmt.Sprintf("%s.%s could not be processed.", tool, key)
			}
		case argObjectJSON:
			objectDecoder := json.NewDecoder(strings.NewReader(string(value)))
			objectDecoder.UseNumber()
			var object map[string]any
			if objectDecoder.Decode(&object) != nil || object == nil {
				return nil, fmt.Sprintf("%s.%s must be a JSON object.", tool, key)
			}
			canonical, err := json.Marshal(object)
			if err != nil {
				return nil, fmt.Sprintf("%s.%s must be a JSON object.", tool, key)
			}
			if err := setFlatString(&flat, mapping.flat, string(canonical)); err != nil {
				return nil, fmt.Sprintf("%s.%s could not be processed.", tool, key)
			}
		}
	}
	encoded, err := json.Marshal(flat)
	if err != nil {
		return nil, fmt.Sprintf("%s arguments could not be processed.", tool)
	}
	return encoded, ""
}

// acceptedParams lists spec's typed parameter names, sorted, for an unknown-key refusal
// message: the model needs to see what it should have typed instead of what it typed.
func acceptedParams(spec map[string]argMapping) []string {
	names := make([]string, 0, len(spec))
	for name := range spec {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// setFlatString assigns one of flatToolArgs' string fields by its JSON field name (itemId,
// parentId, title, markdown, query, propertiesJson or specJson). Two typed arguments
// (templateId and itemId) can map onto the same flat field (itemId) across different
// operations, so this is a small named-field assignment rather than a struct literal. field
// always comes from toolArgSpecs, but an unrecognised value is refused rather than silently
// dropped: a mapping mistake here must surface as a refusal, never as an argument quietly
// vanishing from the flattened call.
func setFlatString(flat *flatToolArgs, field, value string) error {
	switch field {
	case "itemId":
		flat.ItemID = value
	case "parentId":
		flat.ParentID = value
	case "title":
		flat.Title = value
	case "markdown":
		flat.Markdown = value
	case "query":
		flat.Query = value
	case "propertiesJson":
		flat.PropertiesJSON = value
	case "specJson":
		flat.SpecJSON = value
	default:
		return fmt.Errorf("unmapped flat target %q", field)
	}
	return nil
}

func (a *account) listModels(ctx context.Context) error {
	raw, err := a.transport.Call(ctx, "model/list", map[string]any{"limit": 100, "includeHidden": false})
	if err != nil {
		return err
	}
	var page struct {
		Data []struct {
			Model                     string `json:"model"`
			DisplayName               string `json:"displayName"`
			IsDefault                 bool   `json:"isDefault"`
			SupportedReasoningEfforts []struct {
				ReasoningEffort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
			DefaultReasoningEffort string `json:"defaultReasoningEffort"`
		} `json:"data"`
	}
	if len(raw) > 256<<10 || json.Unmarshal(raw, &page) != nil || len(page.Data) > 100 {
		return errors.New("invalid model catalog")
	}
	models := []Model{}
	for _, entry := range page.Data {
		if entry.Model != "" && len(entry.Model) <= 160 && len(entry.DisplayName) <= 200 {
			efforts := make([]string, 0, len(entry.SupportedReasoningEfforts))
			for _, supported := range entry.SupportedReasoningEfforts {
				if supported.ReasoningEffort != "" && len(supported.ReasoningEffort) <= 40 {
					efforts = append(efforts, supported.ReasoningEffort)
				}
			}
			models = append(models, Model{
				ID:               entry.Model,
				Name:             entry.DisplayName,
				Default:          entry.IsDefault,
				supportedEfforts: efforts,
				defaultEffort:    entry.DefaultReasoningEffort,
			})
		}
	}
	a.mu.Lock()
	a.models = models
	a.mu.Unlock()
	return nil
}

// effortFor decides the "effort" value, if any, to send on turn/start: the owner's configured
// value for mode (chatEffort/consultEffort), only when the effective model - explicitModel, or
// else whichever model model/list marked default - actually advertises it. Loads the model list
// once if it has not been loaded yet. Never fails the turn: any problem (the list call failing,
// no default model, the value not being advertised) means an empty result, which send() must
// treat as "omit effort", not as a reason to fail.
func (a *account) effortFor(ctx context.Context, mode, explicitModel string) string {
	configured := a.chatEffort
	if mode == "consult" {
		configured = a.consultEffort
	}
	if configured == "" {
		return ""
	}
	a.mu.Lock()
	loaded := len(a.models) > 0
	a.mu.Unlock()
	if !loaded {
		if err := a.listModels(ctx); err != nil {
			return ""
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var effective *Model
	for i := range a.models {
		if explicitModel != "" {
			if a.models[i].ID == explicitModel {
				effective = &a.models[i]
				break
			}
			continue
		}
		if a.models[i].Default {
			effective = &a.models[i]
			break
		}
	}
	if effective == nil {
		return ""
	}
	for _, supported := range effective.supportedEfforts {
		if supported == configured {
			return configured
		}
	}
	return ""
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
	if json.Unmarshal(raw, &p) != nil || p.Tool == "" || p.CallID == "" || len(p.CallID) > 200 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, c := range a.conversations {
		if c.ThreadID != p.ThreadID || c.State != "thinking" {
			continue
		}
		// Accept p.Tool only when it is one of this conversation mode's typed tool names
		// (catalog.go's toolNamesFor); nix_workspace and anything else the provider might
		// send is rejected here, before any of the checks below run.
		if _, allowed := toolNamesFor(c.Mode)[p.Tool]; !allowed {
			a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", truncateUTF8(p.Tool, 80), "reason", "not offered in this mode"}, map[string]any{"arguments": traceRaw(p.Arguments)})
			return false
		}
		flatArguments, reason := flattenToolCall(p.Tool, p.Arguments)
		if reason != "" {
			// The reason can quote a key the model invented, so the shared log gets a fixed code;
			// the model and the trace get the full sentence.
			a.record(key, slog.LevelWarn, "tool.refused", []any{"tool", p.Tool, "stage", "arguments", "reason_code", argumentRefusalCode(reason)}, map[string]any{"arguments": traceRaw(p.Arguments), "reason": reason})
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason+" No action ran and no approval was requested."))
				return true
			}
			return false
		}
		// The only operation allowed without workspace access is local blueprint
		// validation in Design mode. Reject everything else before returning a tool
		// error, preserving the no-consent boundary for workspace operations.
		if !c.WorkspaceAccess {
			var args struct {
				Operation string `json:"operation"`
			}
			if c.Mode != "consult" || json.Unmarshal(flatArguments, &args) != nil || args.Operation != "validate_blueprint" {
				a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", p.Tool, "reason", "workspace access is off for this message"}, map[string]any{"arguments": traceRaw(p.Arguments)})
				return false
			}
		}
		if reason := validateToolArguments(flatArguments, c.Mode); reason != "" {
			a.record(key, slog.LevelWarn, "tool.refused", []any{"tool", p.Tool, "stage", "validation", "reason", reason}, map[string]any{"arguments": traceRaw(p.Arguments), "flat": traceRaw(flatArguments)})
			if peer, ok := a.transport.(toolTransport); ok {
				_ = peer.Reply(id, toolOutput(false, reason+" No action ran and no approval was requested."))
				return true
			}
			return false
		}
		fingerprint, readOnly := toolIdentity(string(flatArguments))
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
				a.record(key, slog.LevelInfo, "tool.deduplicated", []any{"tool", p.Tool, "status", t.Status, "same_call", t.ID == p.CallID}, nil)
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
			a.record(key, slog.LevelWarn, "tool.rejected", []any{"tool", p.Tool, "reason", "20 tool calls per turn reached"}, nil)
			return false
		}
		c.Tools = append(c.Tools, ToolCall{ID: p.CallID, Arguments: string(flatArguments), Status: "pending", rpcID: append(json.RawMessage{}, id...), pendingSince: time.Now()})
		c.timing.toolRecorded()
		if a.saveLocked(key) != nil {
			c.Tools = c.Tools[:len(c.Tools)-1]
			a.record(key, slog.LevelError, "tool.rejected", []any{"tool", p.Tool, "reason", "conversation could not be saved"}, nil)
			return false
		}
		a.record(key, slog.LevelInfo, "tool.requested", []any{"tool", p.Tool, "arguments_bytes", len(p.Arguments)}, map[string]any{"arguments": traceRaw(p.Arguments), "flat": traceRaw(flatArguments)})
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
	readOnly := operation == "list_items" || operation == "search" || operation == "read_item" || operation == "read_note" || operation == "read_structure" || operation == "list_templates" || operation == "read_template" || operation == "validate_blueprint"
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

// modelParamForItemID names the typed parameter that carries itemId for operation. Every
// operation calls it itemId except nix_read_template and nix_apply_template, which call it
// templateId (toolArgSpecs, above); model-facing messages must name whichever one the model
// actually typed.
func modelParamForItemID(operation string) string {
	if operation == "read_template" || operation == "apply_template" {
		return "templateId"
	}
	return "itemId"
}

func validateToolArguments(raw json.RawMessage, mode string) string {
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
		return "Put markdown inside spec entries, not alongside it."
	}
	if p.Spec != "" && jsonDepth(p.Spec) > 24 {
		return "The design is too large. Use fewer items and fields."
	}
	if p.ParentID != "" && !uuid.MatchString(p.ParentID) {
		return "parentId must be a Nix item UUID or empty for the workspace root."
	}
	if p.ItemID != "" && !uuid.MatchString(p.ItemID) {
		return fmt.Sprintf("%s must be a Nix item UUID.", modelParamForItemID(p.Operation))
	}
	for _, consultOnly := range consultOnlyOperations {
		if p.Operation == consultOnly && mode != "consult" {
			return "This operation is only available in Design mode."
		}
	}
	switch p.Operation {
	case "list_items":
	case "search":
		if strings.TrimSpace(p.Query) == "" {
			return "nix_search requires a nonempty query."
		}
	case "list_templates":
	case "create_note":
		if strings.TrimSpace(p.Title) == "" {
			return "nix_create_note requires a title."
		}
	case "read_item", "read_note", "read_structure", "append_note", "rename_item", "move_item", "set_properties", "trash_item", "restore_item", "read_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_%s requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", p.Operation, modelParamForItemID(p.Operation))
		}
		if p.Operation == "rename_item" && strings.TrimSpace(p.Title) == "" {
			return "nix_rename_item requires a title."
		}
		if p.Operation == "append_note" && strings.TrimSpace(p.Markdown) == "" {
			return "nix_append_note requires nonempty markdown."
		}
		if p.Operation == "set_properties" {
			var object map[string]json.RawMessage
			if json.Unmarshal([]byte(p.Properties), &object) != nil || object == nil {
				return "nix_set_properties requires properties (a JSON object)."
			}
		}
	case "create_structured":
		if strings.TrimSpace(p.Title) == "" {
			return "nix_create_structured requires a title."
		}
		if !isJSONObject(p.Spec) {
			return "nix_create_structured requires spec (a JSON object)."
		}
	case "add_view":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_add_view requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_add_view requires spec (a JSON object)."
		}
	case "create_entries":
		if !uuid.MatchString(p.ParentID) {
			return "nix_create_entries requires the exact parentId UUID. Discover it with nix_list_items or nix_search if it is not already known."
		}
		if !isJSONObject(p.Spec) {
			return "nix_create_entries requires spec (a JSON object)."
		}
	case "add_fields":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_add_fields requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_add_fields requires spec (a JSON object)."
		}
	case "edit_form":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_edit_form requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_edit_form requires spec (a JSON object)."
		}
	case "set_recurrence":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_set_recurrence requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if !isJSONObject(p.Spec) {
			return "nix_set_recurrence requires spec (a JSON object)."
		}
	case "apply_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_apply_template requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if strings.TrimSpace(p.Title) == "" {
			return "nix_apply_template requires a title."
		}
		if p.Spec != "" && !isJSONObject(p.Spec) {
			return "nix_apply_template requires spec (a JSON object) when supplied."
		}
	case "validate_blueprint":
		if !isJSONObject(p.Spec) {
			return "nix_validate_blueprint requires blueprint (a JSON object)."
		}
	case "build_blueprint":
		if !isJSONObject(p.Spec) {
			return "nix_build_blueprint requires blueprint (a JSON object)."
		}
	case "save_as_template":
		if !uuid.MatchString(p.ItemID) {
			return fmt.Sprintf("nix_save_as_template requires the exact %s UUID. Discover it with nix_list_items or nix_search if it is not already known.", modelParamForItemID(p.Operation))
		}
		if strings.TrimSpace(p.Title) == "" {
			return "nix_save_as_template requires a title."
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
				a.record(key, slog.LevelWarn, "tool.claim_refused", []any{"tool", toolOperation(t.Arguments), "status", t.Status, "turn_state", c.State}, nil)
				return errors.New("tool already claimed; do not execute again")
			}
			t.Status = "claimed"
			c.timing.toolClaimed(t.pendingSince)
			pendingMS := int64(0)
			if !t.pendingSince.IsZero() {
				pendingMS = time.Since(t.pendingSince).Milliseconds()
			}
			a.record(key, slog.LevelInfo, "tool.claimed", []any{"tool", toolOperation(t.Arguments), "pending_ms", pendingMS}, nil)
			t.claimedAt = time.Now()
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
		level := slog.LevelInfo
		kind := resultKind(r.ToolSuccess, t.Result)
		if kind == "failed" || kind == "no_result" {
			level = slog.LevelWarn
		}
		runMS := int64(0)
		if !t.claimedAt.IsZero() {
			runMS = time.Since(t.claimedAt).Milliseconds()
		}
		a.record(key, level, "tool.result", []any{"tool", toolOperation(t.Arguments), "outcome", kind, "run_ms", runMS, "result_chars", len(t.Result)}, map[string]any{"result": t.Result})
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
			a.record(key, slog.LevelWarn, "tool.interrupted", []any{"tool", toolOperation(t.Arguments), "status", t.Status}, nil)
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
