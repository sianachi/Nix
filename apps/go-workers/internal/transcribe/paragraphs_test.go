package transcribe

import (
	"strings"
	"testing"
)

func TestParagraphsFollowTheConversation(t *testing.T) {
	paragraphs := Paragraphs([]Spoken{
		{StartMillis: 5000, EndMillis: 7000, Speaker: SpeakerOthers, Text: " Morning. "},
		{StartMillis: 0, EndMillis: 2000, Speaker: SpeakerMe, Text: "Hello everyone."},
		{StartMillis: 2100, EndMillis: 4000, Speaker: SpeakerMe, Text: "Shall we start?"},
		{StartMillis: 7200, EndMillis: 8000, Speaker: SpeakerOthers, Text: "   "},
		{StartMillis: 20000, EndMillis: 21000, Speaker: SpeakerOthers, Text: "One more thing."},
	})

	want := []Paragraph{
		{StartMillis: 0, Speaker: SpeakerMe, Text: "Hello everyone. Shall we start?"},
		{StartMillis: 5000, Speaker: SpeakerOthers, Text: "Morning."},
		// The same speaker after a long pause is a new paragraph with its own time.
		{StartMillis: 20000, Speaker: SpeakerOthers, Text: "One more thing."},
	}
	if len(paragraphs) != len(want) {
		t.Fatalf("paragraphs = %#v", paragraphs)
	}
	for index := range want {
		if paragraphs[index] != want[index] {
			t.Fatalf("paragraph %d = %#v, want %#v", index, paragraphs[index], want[index])
		}
	}
}

func TestAMonologueIsBrokenAtASentenceEnd(t *testing.T) {
	sentence := strings.Repeat("word ", 40) + "end."
	var spoken []Spoken
	for index := range 8 {
		spoken = append(spoken, Spoken{StartMillis: int64(index) * 1000, EndMillis: int64(index)*1000 + 900, Text: sentence})
	}

	paragraphs := Paragraphs(spoken)

	// Three sentences pass the target length, so eight make three, three and two.
	if len(paragraphs) != 3 {
		t.Fatalf("paragraphs = %d", len(paragraphs))
	}
	if paragraphs[1].StartMillis != 3000 || !strings.HasSuffix(paragraphs[0].Text, "end.") {
		t.Fatalf("second paragraph starts at %d", paragraphs[1].StartMillis)
	}
	if Paragraphs(nil) != nil {
		t.Fatal("no speech should be no paragraphs")
	}
}

func TestSpeechWithoutSentenceEndsIsStillCutAndCleaned(t *testing.T) {
	var spoken []Spoken
	for index := range 40 {
		spoken = append(spoken, Spoken{StartMillis: int64(index) * 1000, EndMillis: int64(index)*1000 + 900, Text: strings.Repeat("word ", 30) + "and"})
	}
	spoken = append(spoken, Spoken{StartMillis: 90000, EndMillis: 91000, Text: "nul\x00here " + strings.Repeat("x", 5000)})

	paragraphs := Paragraphs(spoken)

	if len(paragraphs) < 3 {
		t.Fatalf("paragraphs = %d", len(paragraphs))
	}
	for _, paragraph := range paragraphs {
		if length := len([]rune(paragraph.Text)); length > paragraphMaxRunes {
			t.Fatalf("a paragraph of %d characters", length)
		}
		if strings.ContainsRune(paragraph.Text, 0) {
			t.Fatal("a NUL reached the transcript")
		}
	}
}

func TestLongUtterancesKeepTheirEndingWhenSplit(t *testing.T) {
	text := strings.Repeat("word ", 900) + "the ending."
	paragraphs := Paragraphs([]Spoken{{StartMillis: 42, EndMillis: 30000, Speaker: SpeakerMe, Text: text}})
	var parts []string
	for _, paragraph := range paragraphs {
		if paragraph.StartMillis != 42 || paragraph.Speaker != SpeakerMe || len([]rune(paragraph.Text)) > paragraphMaxRunes {
			t.Fatalf("invalid split: %#v", paragraph)
		}
		parts = append(parts, paragraph.Text)
	}
	if strings.Join(parts, " ") != text {
		t.Fatal("the split discarded or changed words")
	}
}
