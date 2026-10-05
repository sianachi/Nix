package transcribe

import (
	"sort"
	"strings"
	"unicode"
)

// Speaker says whose channel an utterance came from, when the recording keeps them apart.
type Speaker string

const (
	// SpeakerNone is a recording that is one mixed sound.
	SpeakerNone Speaker = ""
	// SpeakerMe is the microphone channel of a recording made by Nix.
	SpeakerMe Speaker = "me"
	// SpeakerOthers is the shared-audio channel of a recording made by Nix.
	SpeakerOthers Speaker = "others"
)

// Spoken is one recognised utterance placed on the recording's own timeline.
type Spoken struct {
	StartMillis int64
	EndMillis   int64
	Speaker     Speaker
	Text        string
}

// Paragraph is what the transcript is written in: one speaker's run of speech.
type Paragraph struct {
	StartMillis int64   `json:"startMillis"`
	Speaker     Speaker `json:"speaker"`
	Text        string  `json:"text"`
}

const (
	// A pause this long starts a new paragraph even when the speaker has not changed.
	paragraphGapMillis = 4000
	// A paragraph is closed at the first sentence end past this length, so a monologue is still
	// broken up and each timestamp stays near the words beside it.
	paragraphTargetRunes = 600
	// Speech that never reaches a sentence end is still cut here: Collaboration refuses a
	// paragraph longer than 4000 characters, and nobody reads one that long.
	paragraphMaxRunes = 2000
)

// Paragraphs orders utterances by when they were said and joins each speaker's consecutive ones.
func Paragraphs(spoken []Spoken) []Paragraph {
	ordered := append([]Spoken(nil), spoken...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].StartMillis < ordered[b].StartMillis })

	var paragraphs []Paragraph
	var lastEnd int64
	for _, utterance := range ordered {
		// A NUL cannot be stored in the note, and a recogniser has been known to emit one.
		text := strings.TrimSpace(strings.ReplaceAll(utterance.Text, "\x00", ""))
		if text == "" {
			continue
		}
		for _, text := range splitParagraphText(text) {
			if count := len(paragraphs); count > 0 {
				current := &paragraphs[count-1]
				joins := current.Speaker == utterance.Speaker &&
					utterance.StartMillis-lastEnd < paragraphGapMillis &&
					!(len([]rune(current.Text)) >= paragraphTargetRunes && endsSentence(current.Text)) &&
					len([]rune(current.Text))+1+len([]rune(text)) <= paragraphMaxRunes
				if joins {
					current.Text += " " + text
					lastEnd = max(lastEnd, utterance.EndMillis)
					continue
				}
			}
			paragraphs = append(paragraphs, Paragraph{StartMillis: utterance.StartMillis, Speaker: utterance.Speaker, Text: text})
			lastEnd = utterance.EndMillis
		}
	}
	return paragraphs
}

func endsSentence(text string) bool {
	return strings.HasSuffix(text, ".") || strings.HasSuffix(text, "?") || strings.HasSuffix(text, "!")
}

// Split long recogniser utterances without discarding their ending. Prefer word boundaries;
// timestamps remain at the utterance's start because the recogniser supplies no finer timing.
func splitParagraphText(text string) []string {
	runes := []rune(text)
	var parts []string
	for len(runes) > paragraphMaxRunes {
		cut := paragraphMaxRunes
		for at := cut; at > 0; at-- {
			if unicode.IsSpace(runes[at]) {
				cut = at
				break
			}
		}
		parts = append(parts, strings.TrimSpace(string(runes[:cut])))
		runes = runes[cut:]
		for len(runes) > 0 && unicode.IsSpace(runes[0]) {
			runes = runes[1:]
		}
	}
	if len(runes) > 0 {
		parts = append(parts, string(runes))
	}
	return parts
}
