package docsbrowser

import (
	"errors"
	"fmt"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

type note struct {
	ID, Title, Document, Search string
	Depth                       int
	Links                       []link
}
type location struct {
	Current, Scroll, Horizontal int
	Query                       string
}
type state struct {
	Notes                                   []note
	ByID                                    map[string]int
	Visible                                 []int
	Current, Scroll, Horizontal, LinkCursor int
	Query                                   string
	History                                 []location
}

func newState(lib *library, query string) (*state, error) {
	state := &state{ByID: make(map[string]int)}
	aliases := make(map[string]string)
	for _, row := range lib.Catalog.records() {
		aliases[row.ItemID] = row.Slug + "\n" + row.SourcePath
	}
	for _, desc := range lib.Catalog.Archives {
		children := make(map[string][]nixarchive.Bundle)
		for _, bundle := range lib.Archives[desc.Path] {
			parent := ""
			if bundle.ParentID != nil {
				parent = *bundle.ParentID
			}
			children[parent] = append(children[parent], bundle)
		}
		var visit func(nixarchive.Bundle, int) error
		visit = func(bundle nixarchive.Bundle, depth int) error {
			if _, exists := state.ByID[bundle.ID]; exists {
				return errors.New("duplicate item IDs across documentation archives")
			}
			document, links, err := renderBundle(bundle, true)
			if err != nil {
				return err
			}
			state.ByID[bundle.ID] = len(state.Notes)
			state.Notes = append(state.Notes, note{bundle.ID, bundle.Title, document, strings.ToLower(bundle.Title + "\n" + aliases[bundle.ID] + "\n" + document), depth, links})
			for _, child := range children[bundle.ID] {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
			return nil
		}
		for _, root := range children[""] {
			if err := visit(root, 0); err != nil {
				return nil, err
			}
		}
	}
	if len(state.Notes) == 0 {
		return nil, errors.New("no documentation notes found")
	}
	state.search("")
	if query != "" {
		row, err := lib.selectRecord(query)
		if err != nil {
			return nil, err
		}
		state.selectNote(state.ByID[row.ItemID])
	}
	return state, nil
}
func (s *state) selectNote(index int) {
	s.Current = index
	s.Scroll, s.Horizontal, s.LinkCursor = 0, 0, 0
}
func (s *state) cursor() int {
	for index, value := range s.Visible {
		if value == s.Current {
			return index
		}
	}
	return 0
}
func (s *state) move(delta int) {
	if len(s.Visible) != 0 {
		s.selectNote(s.Visible[max(0, min(len(s.Visible)-1, s.cursor()+delta))])
	}
}
func (s *state) search(query string) {
	s.Query = query
	s.Visible = nil
	found := false
	for index, note := range s.Notes {
		if strings.Contains(note.Search, strings.ToLower(query)) {
			s.Visible = append(s.Visible, index)
			found = found || index == s.Current
		}
	}
	if !found && len(s.Visible) != 0 {
		s.selectNote(s.Visible[0])
	}
}
func (s *state) location() location { return location{s.Current, s.Scroll, s.Horizontal, s.Query} }
func (s *state) restore(loc location) {
	s.search(loc.Query)
	s.selectNote(loc.Current)
	s.Scroll, s.Horizontal = loc.Scroll, loc.Horizontal
}
func (s *state) follow() string {
	links := s.Notes[s.Current].Links
	if len(links) == 0 {
		return "This note has no internal links"
	}
	selected := links[s.LinkCursor]
	index, exists := s.ByID[selected.Target]
	if !exists {
		return "Link is outside these archives: " + selected.Label
	}
	s.History = append(s.History, s.location())
	s.search("")
	s.selectNote(index)
	return "Opened " + selected.Label
}
func (s *state) back() string {
	if len(s.History) == 0 {
		return "No earlier link navigation"
	}
	last := len(s.History) - 1
	s.restore(s.History[last])
	s.History = s.History[:last]
	return "Returned to previous note"
}
func (s *state) linkStatus() string {
	links := s.Notes[s.Current].Links
	if len(links) == 0 {
		return "No internal links"
	}
	return fmt.Sprintf("Link %d/%d: %s", s.LinkCursor+1, len(links), links[s.LinkCursor].Label)
}
