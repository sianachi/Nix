package docsbrowser

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

type node struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Attrs   map[string]any `json:"attrs"`
	Content []node         `json:"content"`
	Marks   []node         `json:"marks"`
}
type link struct{ Label, Target string }

func bodyNode(bundle nixarchive.Bundle) (node, error) {
	var body struct {
		Prosemirror *node `json:"prosemirror"`
	}
	if err := json.Unmarshal(bundle.Body, &body); err != nil {
		return node{}, err
	}
	if body.Prosemirror == nil || body.Prosemirror.Type != "doc" {
		return node{}, errors.New("documentation note has no native document body")
	}
	return *body.Prosemirror, nil
}
func attr(part node, key string) string { value, _ := part.Attrs[key].(string); return value }
func originalSource(bundle nixarchive.Bundle) (string, error) {
	body, err := bodyNode(bundle)
	if err != nil {
		return "", err
	}
	if len(body.Content) != 1 || body.Content[0].Type != "codeBlock" {
		return "", errors.New("preserved source must be one verbatim code block")
	}
	var result strings.Builder
	for _, child := range body.Content[0].Content {
		if child.Type != "text" {
			return "", errors.New("preserved source contains a non-text node")
		}
		result.WriteString(child.Text)
	}
	return result.String(), nil
}

func renderBundle(bundle nixarchive.Bundle, numbered bool) (string, []link, error) {
	body, err := bodyNode(bundle)
	if err != nil {
		return "", nil, err
	}
	var links []link
	addLink := func(label, target string) string {
		links = append(links, link{label, target})
		if numbered {
			return fmt.Sprintf("[%d] %s", len(links), label)
		}
		return label + " (nix://item/" + target + ")"
	}
	var inline func(node) string
	inline = func(part node) string {
		switch part.Type {
		case "text":
			value := part.Text
			for _, mark := range part.Marks {
				if numbered {
					switch mark.Type {
					case "bold":
						value = "**" + value + "**"
					case "italic":
						value = "*" + value + "*"
					case "code":
						value = "`" + value + "`"
					case "strike":
						value = "~~" + value + "~~"
					}
				}
				if mark.Type != "link" {
					continue
				}
				href := attr(mark, "href")
				if strings.HasPrefix(href, "nix://item/") {
					value = addLink(value, strings.TrimPrefix(href, "nix://item/"))
				} else if href != "" && href != value {
					value += " (" + href + ")"
				}
			}
			return value
		case "reference":
			label := attr(part, "label")
			if label == "" {
				label = "Item"
			}
			return addLink(label, attr(part, "targetId"))
		case "hardBreak":
			return "\n"
		}
		var result strings.Builder
		for _, child := range part.Content {
			result.WriteString(inline(child))
		}
		return result.String()
	}
	var blocks func(node, string) []string
	blocks = func(part node, indent string) []string {
		switch part.Type {
		case "codeBlock":
			var code strings.Builder
			for _, child := range part.Content {
				code.WriteString(child.Text)
			}
			fence := "```"
			if strings.Contains(code.String(), fence) {
				fence = "````"
			}
			lines := []string{fence + attr(part, "language")}
			lines = append(lines, strings.Split(code.String(), "\n")...)
			return append(lines, fence, "")
		case "heading":
			level, _ := part.Attrs["level"].(float64)
			return []string{indent + strings.Repeat("#", max(1, min(6, int(level)))) + " " + inline(part), ""}
		case "paragraph":
			lines := strings.Split(inline(part), "\n")
			for index := range lines {
				lines[index] = indent + lines[index]
			}
			return append(lines, "")
		case "bulletList", "orderedList":
			var lines []string
			start, ok := part.Attrs["start"].(float64)
			if !ok {
				start = 1
			}
			for index, child := range part.Content {
				body := blocks(child, indent+"  ")
				marker := "- "
				if part.Type == "orderedList" {
					marker = fmt.Sprintf("%d. ", int(start)+index)
				}
				if len(body) != 0 {
					body[0] = indent + marker + strings.TrimLeft(body[0], " ")
				}
				lines = append(lines, body...)
			}
			return append(lines, "")
		case "table":
			var lines []string
			for _, row := range part.Content {
				var cells []string
				for _, cell := range row.Content {
					cells = append(cells, strings.ReplaceAll(inline(cell), "\n", " "))
				}
				lines = append(lines, indent+strings.Join(cells, " | "))
			}
			return append(lines, "")
		case "horizontalRule":
			return []string{"---", ""}
		}
		var lines []string
		for _, child := range part.Content {
			lines = append(lines, blocks(child, indent)...)
		}
		if part.Type == "blockquote" {
			for index := range lines {
				lines[index] = "> " + lines[index]
			}
		}
		return lines
	}
	return strings.TrimRight(strings.Join(blocks(body, ""), "\n"), "\n") + "\n", links, nil
}

type displayLine struct {
	Text string
	Code bool
}

func runeWidth(char rune) int {
	if unicode.Is(unicode.Mn, char) || unicode.Is(unicode.Me, char) {
		return 0
	}
	// Wide Unicode blocks cover the CJK text found in documentation.
	if char >= 0x1100 && (char <= 0x115f || char >= 0x2e80 && char <= 0xa4cf || char >= 0xac00 && char <= 0xd7a3 || char >= 0xf900 && char <= 0xfaff || char >= 0xfe10 && char <= 0xfe6f || char >= 0xff00 && char <= 0xff60 || char >= 0xffe0 && char <= 0xffe6 || char >= 0x1f300 && char <= 0x1faff || char >= 0x20000 && char <= 0x3fffd) {
		return 2
	}
	return 1
}

func safeText(value string) string {
	var result strings.Builder
	for _, char := range value {
		if char == '\t' {
			result.WriteString("    ")
		} else if unicode.IsControl(char) || unicode.Is(unicode.Cf, char) {
			result.WriteRune('?')
		} else {
			result.WriteRune(char)
		}
	}
	return result.String()
}
func cellSlice(value string, start, width int) string {
	var result strings.Builder
	position := 0
	for _, char := range safeText(value) {
		size := runeWidth(char)
		if position >= start && position+size <= start+width {
			result.WriteRune(char)
		}
		position += size
		if position > start+width {
			break
		}
	}
	return result.String()
}
func wrapDocument(document string, width int) []displayLine {
	width = max(1, width)
	var result []displayLine
	fence := ""
	for _, line := range strings.Split(strings.TrimSuffix(document, "\n"), "\n") {
		if fence != "" {
			result = append(result, displayLine{line, true})
			if line == fence {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(line, "```") {
			fence = "```"
			if strings.HasPrefix(line, "````") {
				fence = "````"
			}
			result = append(result, displayLine{line, true})
			continue
		}
		line = safeText(line)
		if line == "" {
			result = append(result, displayLine{})
			continue
		}
		indent := line[:len(line)-len(strings.TrimLeft(line, " "))]
		if len(indent) >= width {
			indent = ""
		}
		for line != "" {
			runes := []rune(line)
			cells, end, lastSpace := 0, 0, -1
			for end < len(runes) && cells+runeWidth(runes[end]) <= width {
				cells += runeWidth(runes[end])
				if runes[end] == ' ' && end > len(indent) {
					lastSpace = end
				}
				end++
			}
			if end == len(runes) {
				result = append(result, displayLine{line, false})
				break
			}
			if lastSpace > 0 {
				end = lastSpace
			}
			end = max(1, end)
			result = append(result, displayLine{string(runes[:end]), false})
			if end <= len(indent) {
				indent = ""
			}
			remaining := strings.TrimLeft(string(runes[end:]), " ")
			if remaining == "" {
				break
			}
			line = indent + remaining
		}

	}
	return result
}
