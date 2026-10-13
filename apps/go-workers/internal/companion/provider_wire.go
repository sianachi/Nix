package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// The two wire formats behind httpTransport. Each turns the provider-neutral thread into one
// streaming request and reports deltas and tool calls back; neither interprets content.

type anthropicWire struct{}

const anthropicBase = "https://api.anthropic.com"

// anthropicMaxTokens bounds one response. Thinking counts against it, and a whole structure draft
// arrives as one tool call, so 4096 cut both off. 32000 is the lowest cap among the models a key
// may list (Opus 4/4.1); a higher value would be refused by those models.
const anthropicMaxTokens = 32000

// errResponseTooLong fails a turn whose response hit the output cap: a truncated tool call is never
// run, and the turn is not reported as completed.
var errResponseTooLong = errors.New("The reply reached the model's length limit before it finished, so nothing was changed. Ask for a smaller piece at a time")

// anthropicModels is the fixed catalog offered when the key cannot list models. Anthropic's
// /v1/models endpoint is used first; this is the honest fallback, not a guess about new models.
var anthropicModels = []Model{
	{ID: "claude-sonnet-4-5", Name: "Claude Sonnet 4.5", Default: true, SupportsTools: true},
	{ID: "claude-opus-4-1", Name: "Claude Opus 4.1", SupportsTools: true},
	{ID: "claude-haiku-4-5", Name: "Claude Haiku 4.5", SupportsTools: true},
}

func anthropicRequest(ctx context.Context, base, method, path, apiKey string, body any) (*http.Request, error) {
	if base == "" {
		base = anthropicBase
	}
	var payload *bytes.Reader
	if body == nil {
		payload = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, payload)
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-api-key", apiKey)
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set("content-type", "application/json")
	return request, nil
}

func (anthropicWire) listModels(ctx context.Context, client *http.Client, base, apiKey string) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 20_000_000_000)
	defer cancel()
	request, err := anthropicRequest(ctx, base, http.MethodGet, "/v1/models?limit=100", apiKey, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Anthropic could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return anthropicModels, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, providerResponseError("anthropic", response, true)
	}
	var page struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if json.NewDecoder(&boundedReader{r: response.Body, limit: 256 << 10}).Decode(&page) != nil {
		return nil, errors.New("Anthropic returned an unreadable model list")
	}
	models := make([]Model, 0, len(page.Data))
	for i, entry := range page.Data {
		if entry.ID == "" || len(entry.ID) > 160 {
			continue
		}
		name := entry.DisplayName
		if name == "" {
			name = entry.ID
		}
		models = append(models, Model{ID: entry.ID, Name: name, Default: i == 0, SupportsTools: true})
	}
	if len(models) == 0 {
		return anthropicModels, nil
	}
	return models, nil
}

func (anthropicWire) stream(ctx context.Context, client *http.Client, base, apiKey string, thread *httpThread, onDelta func(string)) (string, []providerToolCall, error) {
	ctx, cancel := context.WithTimeout(ctx, providerTimeout)
	defer cancel()
	messages := make([]map[string]any, 0, len(thread.Messages))
	for _, message := range thread.Messages {
		switch {
		case message.Role == "user" && len(message.ToolResults) > 0:
			content := make([]map[string]any, 0, len(message.ToolResults))
			for _, result := range message.ToolResults {
				content = append(content, map[string]any{"type": "tool_result", "tool_use_id": result.CallID, "content": result.Text, "is_error": result.IsError})
			}
			messages = append(messages, map[string]any{"role": "user", "content": content})
		case message.Role == "assistant":
			content := make([]map[string]any, 0, 1+len(message.ToolCalls))
			if message.Text != "" {
				content = append(content, map[string]any{"type": "text", "text": message.Text})
			}
			for _, call := range message.ToolCalls {
				input := json.RawMessage(call.Arguments)
				if len(input) == 0 {
					input = json.RawMessage(`{}`)
				}
				content = append(content, map[string]any{"type": "tool_use", "id": call.ID, "name": call.Name, "input": input})
			}
			if len(content) == 0 {
				continue
			}
			messages = append(messages, map[string]any{"role": "assistant", "content": content})
		default:
			messages = append(messages, map[string]any{"role": "user", "content": message.Text})
		}
	}
	tools := make([]map[string]any, 0, len(thread.Tools))
	for _, declared := range thread.Tools {
		var tool struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"inputSchema"`
		}
		if json.Unmarshal(declared, &tool) == nil && tool.Name != "" {
			tools = append(tools, map[string]any{"name": tool.Name, "description": tool.Description, "input_schema": tool.InputSchema})
		}
	}
	body := map[string]any{"model": thread.Model, "max_tokens": anthropicMaxTokens, "system": thread.System, "messages": messages, "stream": true}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	request, err := anthropicRequest(ctx, base, http.MethodPost, "/v1/messages", apiKey, body)
	if err != nil {
		return "", nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return "", nil, ctx.Err()
		}
		return "", nil, errors.New("Anthropic could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, providerResponseError("anthropic", response, false)
	}
	var text strings.Builder
	calls := []providerToolCall{}
	type block struct {
		kind string
		call providerToolCall
		json strings.Builder
	}
	blocks := map[int]*block{}
	stopReason, stopped := "", false
	err = readSSE(ctx, response.Body, func(_ string, data []byte) error {
		var event struct {
			Type         string `json:"type"`
			Index        int    `json:"index"`
			ContentBlock *struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta *struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &event) != nil {
			return nil
		}
		switch event.Type {
		case "error":
			if event.Error != nil {
				return errors.New("Anthropic reported an error during the response")
			}
		case "message_delta":
			if event.Delta != nil && event.Delta.StopReason != "" {
				stopReason = event.Delta.StopReason
			}
		case "message_stop":
			stopped = true
		case "content_block_start":
			if event.ContentBlock != nil {
				b := &block{kind: event.ContentBlock.Type}
				if event.ContentBlock.Type == "tool_use" {
					b.call = providerToolCall{ID: event.ContentBlock.ID, Name: event.ContentBlock.Name}
				}
				blocks[event.Index] = b
			}
		case "content_block_delta":
			if event.Delta == nil {
				return nil
			}
			if event.Delta.Type == "text_delta" && event.Delta.Text != "" {
				text.WriteString(event.Delta.Text)
				onDelta(event.Delta.Text)
			}
			if event.Delta.Type == "input_json_delta" {
				if b := blocks[event.Index]; b != nil {
					b.json.WriteString(event.Delta.PartialJSON)
				}
			}
		case "content_block_stop":
			if b := blocks[event.Index]; b != nil && b.kind == "tool_use" {
				arguments := b.json.String()
				if strings.TrimSpace(arguments) == "" {
					arguments = "{}"
				}
				b.call.Arguments = json.RawMessage(arguments)
				calls = append(calls, b.call)
			}
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	// Only a stream that reached message_stop is a whole answer; a cut connection would otherwise
	// look like a short reply with its unfinished tool call silently dropped.
	switch {
	case stopReason == "max_tokens":
		return "", nil, errResponseTooLong
	case stopReason == "refusal":
		return "", nil, errors.New("Claude declined this request. Rephrase it or pick another model")
	case !stopped:
		return "", nil, errors.New("Anthropic ended the response early, so nothing was changed. Try again")
	}
	return text.String(), calls, nil
}

type openrouterWire struct{}

const openrouterBase = "https://openrouter.ai/api/v1"

func openrouterRequest(ctx context.Context, base, method, path, apiKey string, body any) (*http.Request, error) {
	if base == "" {
		base = openrouterBase
	}
	var payload *bytes.Reader
	if body == nil {
		payload = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, payload)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("X-Title", "Nix companion")
	return request, nil
}

func (openrouterWire) listModels(ctx context.Context, client *http.Client, base, apiKey string) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 20_000_000_000)
	defer cancel()
	request, err := openrouterRequest(ctx, base, http.MethodGet, "/models", apiKey, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("OpenRouter could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, providerResponseError("openrouter", response, true)
	}
	var page struct {
		Data []struct {
			ID                  string   `json:"id"`
			Name                string   `json:"name"`
			SupportedParameters []string `json:"supported_parameters"`
		} `json:"data"`
	}
	if json.NewDecoder(&boundedReader{r: response.Body, limit: 4 << 20}).Decode(&page) != nil {
		return nil, errors.New("OpenRouter returned an unreadable model list")
	}
	models := make([]Model, 0, 100)
	for _, entry := range page.Data {
		if entry.ID == "" || len(entry.ID) > 160 || len(models) == 100 {
			continue
		}
		supportsTools := false
		for _, parameter := range entry.SupportedParameters {
			if parameter == "tools" {
				supportsTools = true
			}
		}
		name := entry.Name
		if name == "" || len(name) > 200 {
			name = entry.ID
		}
		models = append(models, Model{ID: entry.ID, Name: name, SupportsTools: supportsTools})
	}
	if len(models) == 0 {
		return nil, errors.New("OpenRouter listed no models for this key")
	}
	models[0].Default = true
	return models, nil
}

func (openrouterWire) stream(ctx context.Context, client *http.Client, base, apiKey string, thread *httpThread, onDelta func(string)) (string, []providerToolCall, error) {
	ctx, cancel := context.WithTimeout(ctx, providerTimeout)
	defer cancel()
	messages := []map[string]any{{"role": "system", "content": thread.System}}
	for _, message := range thread.Messages {
		switch {
		case message.Role == "user" && len(message.ToolResults) > 0:
			for _, result := range message.ToolResults {
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": result.CallID, "content": result.Text})
			}
		case message.Role == "assistant":
			entry := map[string]any{"role": "assistant", "content": message.Text}
			if len(message.ToolCalls) > 0 {
				toolCalls := make([]map[string]any, 0, len(message.ToolCalls))
				for _, call := range message.ToolCalls {
					arguments := string(call.Arguments)
					if strings.TrimSpace(arguments) == "" {
						arguments = "{}"
					}
					toolCalls = append(toolCalls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": arguments}})
				}
				entry["tool_calls"] = toolCalls
			}
			messages = append(messages, entry)
		default:
			messages = append(messages, map[string]any{"role": "user", "content": message.Text})
		}
	}
	tools := make([]map[string]any, 0, len(thread.Tools))
	for _, declared := range thread.Tools {
		var tool struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"inputSchema"`
		}
		if json.Unmarshal(declared, &tool) == nil && tool.Name != "" {
			tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.InputSchema}})
		}
	}
	body := map[string]any{"model": thread.Model, "messages": messages, "stream": true}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	request, err := openrouterRequest(ctx, base, http.MethodPost, "/chat/completions", apiKey, body)
	if err != nil {
		return "", nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return "", nil, ctx.Err()
		}
		return "", nil, errors.New("OpenRouter could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", nil, providerResponseError("openrouter", response, false)
	}
	var text strings.Builder
	type partial struct {
		id, name  string
		arguments strings.Builder
	}
	partials := map[int]*partial{}
	order := []int{}
	err = readSSE(ctx, response.Body, func(_ string, data []byte) error {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &chunk) != nil {
			return nil
		}
		if chunk.Error != nil {
			return errors.New("OpenRouter reported an error during the response")
		}
		for _, choice := range chunk.Choices {
			if choice.FinishReason == "length" {
				return errResponseTooLong
			}
			if choice.Delta.Content != "" {
				text.WriteString(choice.Delta.Content)
				onDelta(choice.Delta.Content)
			}
			for _, call := range choice.Delta.ToolCalls {
				p := partials[call.Index]
				if p == nil {
					p = &partial{}
					partials[call.Index] = p
					order = append(order, call.Index)
				}
				if call.ID != "" {
					p.id = call.ID
				}
				if call.Function.Name != "" {
					p.name = call.Function.Name
				}
				p.arguments.WriteString(call.Function.Arguments)
			}
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	calls := make([]providerToolCall, 0, len(order))
	for _, index := range order {
		p := partials[index]
		if p.name == "" {
			continue
		}
		arguments := p.arguments.String()
		if strings.TrimSpace(arguments) == "" {
			arguments = "{}"
		}
		if p.id == "" {
			p.id = "call-" + strings.ReplaceAll(p.name, " ", "-")
		}
		calls = append(calls, providerToolCall{ID: p.id, Name: p.name, Arguments: json.RawMessage(arguments)})
	}
	return text.String(), calls, nil
}

// boundedReader stops a provider body at a limit so a response can never grow memory without end.
type boundedReader struct {
	r     interface{ Read([]byte) (int, error) }
	limit int
	read  int
}

func (b *boundedReader) Read(p []byte) (int, error) {
	if b.read >= b.limit {
		return 0, errors.New("provider response too large")
	}
	if len(p) > b.limit-b.read {
		p = p[:b.limit-b.read]
	}
	n, err := b.r.Read(p)
	b.read += n
	return n, err
}
