package docsbrowser

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"unicode/utf8"
)

type keyParser struct{ pending []byte }

func (parser *keyParser) feed(data []byte, flush bool) []string {
	parser.pending = append(parser.pending, data...)
	var keys []string
	sequences := map[string]string{"\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end", "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left", "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[7~": "home", "\x1b[8~": "end"}
	for len(parser.pending) != 0 {
		if parser.pending[0] == 27 {
			if len(parser.pending) == 1 {
				if !flush {
					break
				}
				keys = append(keys, "escape")
				parser.pending = parser.pending[1:]
				continue
			}
			if parser.pending[1] == '[' || parser.pending[1] == 'O' {
				end := 2
				for end < len(parser.pending) && !(parser.pending[end] >= 0x40 && parser.pending[end] <= 0x7e) {
					end++
				}
				if end == len(parser.pending) {
					if !flush && len(parser.pending) < 64 {
						break
					}
					parser.pending = nil
					continue
				}
				if key := sequences[string(parser.pending[:end+1])]; key != "" {
					keys = append(keys, key)
				}
				parser.pending = parser.pending[end+1:]
				continue
			}
			keys = append(keys, "escape")
			parser.pending = parser.pending[1:]
			continue
		}
		if !utf8.FullRune(parser.pending) && !flush {
			break
		}
		char, size := utf8.DecodeRune(parser.pending)
		parser.pending = parser.pending[size:]
		switch char {
		case 3:
			keys = append(keys, "quit")
		case 9:
			keys = append(keys, "tab")
		case 10, 13:
			keys = append(keys, "enter")
		case 8, 127:
			keys = append(keys, "backspace")
		default:
			if char >= 32 && char != utf8.RuneError {
				keys = append(keys, string(char))
			}
		}
	}
	return keys
}

type tui struct {
	state             *state
	Reader, Searching bool
	SearchBefore      location
	TreeTop           int
	Message           string
}

func (ui *tui) key(key string, height int) bool {
	s := ui.state
	if key == "quit" {
		return true
	}
	if ui.Searching {
		switch key {
		case "enter":
			ui.Searching = false
			ui.Message = fmt.Sprintf("%d matching notes", len(s.Visible))
		case "escape":
			s.restore(ui.SearchBefore)
			ui.Searching = false
		case "backspace":
			if s.Query != "" {
				_, size := utf8.DecodeLastRuneInString(s.Query)
				s.search(s.Query[:len(s.Query)-size])
			}
		default:
			if utf8.RuneCountInString(key) == 1 {
				s.search(s.Query + key)
			}
		}
		return false
	}
	switch key {
	case "q":
		return true
	case "/":
		ui.SearchBefore = s.location()
		s.search("")
		ui.Searching = true
	case "escape":
		s.search("")
		ui.Message = "Search cleared"
	case "tab":
		ui.Reader = !ui.Reader
	case "b", "backspace":
		ui.Message = s.back()
	case "enter":
		if ui.Reader {
			ui.Message = s.follow()
		} else {
			ui.Reader = true
		}
	case "n", "p":
		links := s.Notes[s.Current].Links
		if ui.Reader && len(links) != 0 {
			direction := 1
			if key == "p" {
				direction = -1
			}
			s.LinkCursor = (s.LinkCursor + direction + len(links)) % len(links)
		}
	case "left", "h":
		if ui.Reader {
			s.Horizontal = max(0, s.Horizontal-8)
		}
	case "right", "l":
		if ui.Reader {
			s.Horizontal += 8
		}
	case "up", "k", "down", "j":
		direction := 1
		if key == "up" || key == "k" {
			direction = -1
		}
		if ui.Reader {
			s.Scroll += direction
		} else {
			s.move(direction)
		}
	case "pageup":
		s.Scroll -= height
	case "pagedown":
		s.Scroll += height
	case "home", "end":
		if !ui.Reader && len(s.Visible) != 0 {
			index := 0
			if key == "end" {
				index = len(s.Visible) - 1
			}
			s.selectNote(s.Visible[index])
		} else if key == "home" {
			s.Scroll = 0
		} else {
			s.Scroll = 1 << 30
		}
	}
	return false
}

func (ui *tui) frame(width, height int) string {
	var frame strings.Builder
	frame.WriteString("\x1b[H\x1b[2J")
	draw := func(row, column int, value string, limit int, style string, horizontal int) {
		if row < 0 || row >= height || column < 0 || column >= width || limit <= 0 {
			return
		}
		fmt.Fprintf(&frame, "\x1b[%d;%dH%s%s\x1b[0m", row+1, column+1, style, cellSlice(value, horizontal, min(limit, width-column-1)))
	}
	if width < 60 || height < 10 {
		draw(0, 0, "Nix docs: enlarge terminal to at least 60 x 10; q quits", width-1, "", 0)
		return frame.String()
	}
	s := ui.state
	split := min(42, max(22, width/3))
	bodyWidth, bodyHeight := width-split-3, height-6
	wrapped := wrapDocument(s.Notes[s.Current].Document, bodyWidth)
	s.Scroll = max(0, min(s.Scroll, max(0, len(wrapped)-bodyHeight)))
	draw(0, 0, "Nix documentation | offline native archives", width-1, "\x1b[1m", 0)
	pane := "Pages [Tab]"
	if !ui.Reader {
		pane = "Pages"
	}
	draw(1, 0, fmt.Sprintf("%s (%d/%d)", pane, len(s.Visible), len(s.Notes)), split-1, "\x1b[1m", 0)
	draw(1, split+2, s.Notes[s.Current].Title, bodyWidth, "\x1b[1m", 0)
	for row := 1; row < height-3; row++ {
		draw(row, split, "|", 1, "", 0)
	}
	cursor := s.cursor()
	ui.TreeTop = max(0, min(ui.TreeTop, cursor))
	ui.TreeTop = max(ui.TreeTop, cursor-bodyHeight+1)
	ui.TreeTop = min(ui.TreeTop, max(0, len(s.Visible)-bodyHeight))
	for offset, index := range s.Visible[ui.TreeTop:min(len(s.Visible), ui.TreeTop+bodyHeight)] {
		note := s.Notes[index]
		marker, style := "  ", ""
		if index == s.Current {
			marker = "> "
			style = "\x1b[1m"
			if !ui.Reader {
				style = "\x1b[7m"
			}
		}
		draw(2+offset, 0, marker+strings.Repeat("  ", min(note.Depth, 5))+note.Title, split-1, style, 0)
	}
	if len(s.Visible) == 0 {
		draw(2, 0, "No matching notes", split-1, "", 0)
	}
	for offset, line := range wrapped[s.Scroll:min(len(wrapped), s.Scroll+bodyHeight)] {
		style := ""
		if line.Code {
			style = "\x1b[2m"
		} else if strings.HasPrefix(strings.TrimLeft(line.Text, " "), "#") {
			style = "\x1b[1m"
		}
		if s.Query != "" && strings.Contains(strings.ToLower(line.Text), strings.ToLower(s.Query)) {
			style = "\x1b[7m"
		}
		draw(2+offset, split+2, line.Text, bodyWidth, style, s.Horizontal)
	}
	draw(height-4, split+2, fmt.Sprintf("Lines %d-%d/%d | %s", s.Scroll+1, min(len(wrapped), s.Scroll+bodyHeight), len(wrapped), s.linkStatus()), bodyWidth, "\x1b[1m", 0)
	draw(height-3, 0, "Tab panes | arrows/j/k move | PgUp/PgDn scroll | Home/End | / search", width-1, "", 0)
	draw(height-2, 0, "Reader: n/p link, Enter follow, b back, h/l horizontal | Esc clear | q quit", width-1, "", 0)
	status, style := ui.Message, ""
	if s.Query != "" {
		status = "Search: " + s.Query
	}
	if ui.Searching {
		status = "/" + s.Query + "_"
		style = "\x1b[7m"
	}
	draw(height-1, 0, status, width-1, style, 0)
	return frame.String()
}

func runTUI(lib *library, query string, input *os.File, output io.Writer) error {
	out, ok := output.(*os.File)
	if !ok {
		return errors.New("TUI requires an interactive terminal; use list, read, source or check for piped output")
	}
	inFD, outFD := int(input.Fd()), int(out.Fd())
	width, height, err := terminalSize(outFD)
	if err != nil {
		return errors.New("TUI requires an interactive terminal; use list, read, source or check for piped output")
	}
	if _, _, err := terminalSize(inFD); err != nil {
		return errors.New("TUI requires an interactive terminal on stdin; use list, read, source or check for piped output")
	}
	if os.Getenv("TERM") == "dumb" {
		return errors.New("TUI requires an ANSI terminal; use list or read with TERM=dumb")
	}
	state, err := newState(lib, query)
	if err != nil {
		return err
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	restore, err := enterRaw(inFD)
	if err != nil {
		return fmt.Errorf("cannot enter terminal mode: %w", err)
	}
	defer restore()
	defer func() { _, _ = io.WriteString(output, "\x1b[0m\x1b[?25h\x1b[?1049l") }()
	if _, err := io.WriteString(output, "\x1b[?1049h\x1b[?25l"); err != nil {
		return err
	}
	ui := &tui{state: state, Message: "Tab switches panes; / searches all notes; q quits"}
	parser := &keyParser{}
	dirty := true
	for {
		if dirty {
			if _, err := io.WriteString(output, ui.frame(width, height)); err != nil {
				return err
			}
			dirty = false
		}
		select {
		case <-stop:
			return nil
		default:
		}
		data, err := readInput(inFD)
		if err != nil {
			return err
		}
		keys := parser.feed(data, len(data) == 0)
		for _, key := range keys {
			if ui.key(key, max(1, height-6)) {
				return nil
			}
			dirty = true
		}
		nextWidth, nextHeight, err := terminalSize(outFD)
		if err != nil {
			return err
		}
		if nextWidth != width || nextHeight != height {
			width, height = nextWidth, nextHeight
			dirty = true
		}
	}
}
