using System.Globalization;
using System.Text;
using Nix.Domain.Links;

namespace Nix.Tests.Features.Search;

/// <summary>
/// How a passage is cut into the phrases a title could equal.
/// </summary>
/// <remarks>
/// The cut decides both what counts as a mention and how much work the statement does, so the
/// assertions are about each: a phrase that should match is produced, one that must not is not, and
/// the array never grows past its published ceiling however the text is shaped.
/// </remarks>
public sealed class MentionPhrasesTests
{
    [Fact]
    public void A_multi_word_title_in_running_text_is_produced_lower_cased_and_single_spaced()
    {
        var set = MentionPhrases.Extract("We should revisit Project   Atlas next week");

        Assert.Contains("project atlas", set.Phrases);
        Assert.Equal("Project   Atlas", set.Originals["project atlas"]);
    }

    [Fact]
    public void Punctuation_at_a_word_edge_is_stripped_and_inner_punctuation_is_kept()
    {
        var set = MentionPhrases.Extract("Ported it to (Node.js), finally.");

        Assert.Contains("node.js", set.Phrases);
        Assert.Contains("finally", set.Phrases);
        Assert.DoesNotContain(set.Phrases, phrase => phrase.Contains('(', StringComparison.Ordinal));
    }

    [Fact]
    public void A_phrase_never_spans_sentence_punctuation()
    {
        // "Alice Smith" is a document; this sentence does not mention it.
        var set = MentionPhrases.Extract("I met Alice. Smith arrived later");

        Assert.DoesNotContain("alice smith", set.Phrases);
        Assert.Contains("alice", set.Phrases);
        Assert.Contains("smith arrived later", set.Phrases);
    }

    [Fact]
    public void A_phrase_never_spans_a_line_break()
    {
        var set = MentionPhrases.Extract("Groceries\nPlanning notes");

        Assert.DoesNotContain("groceries planning", set.Phrases);
        Assert.Contains("planning notes", set.Phrases);
    }

    [Fact]
    public void A_free_standing_dash_separates_phrases()
    {
        var set = MentionPhrases.Extract("Atlas - Roadmap");

        Assert.DoesNotContain("atlas roadmap", set.Phrases);
    }

    [Fact]
    public void Short_single_words_and_pure_numbers_are_not_candidates()
    {
        var set = MentionPhrases.Extract("Q3 was 2024 and 3.14 but the plan held");

        Assert.DoesNotContain("q3", set.Phrases);
        Assert.DoesNotContain("was", set.Phrases);
        Assert.DoesNotContain("2024", set.Phrases);
        Assert.DoesNotContain("3.14", set.Phrases);
        Assert.Contains("plan", set.Phrases);
        Assert.Contains("held", set.Phrases);

        // A short word is fine inside a longer phrase: "Q3 plan" is a plausible title.
        Assert.Contains("q3 was", set.Phrases);
    }

    [Fact]
    public void A_phrase_made_only_of_numbers_is_not_a_candidate_at_any_length()
    {
        var set = MentionPhrases.Extract("2024 10 31");

        Assert.Empty(set.Phrases);
    }

    [Fact]
    public void No_phrase_is_longer_than_the_word_ceiling()
    {
        var set = MentionPhrases.Extract("one two three four five six seven eight");

        Assert.Contains("one two three four five six", set.Phrases);
        Assert.DoesNotContain("one two three four five six seven", set.Phrases);
        Assert.All(set.Phrases, phrase =>
            Assert.True(phrase.Split(' ').Length <= MentionPhrases.MaximumWords, phrase));
    }

    [Fact]
    public void A_repeated_phrase_is_produced_once_and_keeps_its_first_spelling()
    {
        var set = MentionPhrases.Extract("Budget review. Then the BUDGET REVIEW again.");

        Assert.Single(set.Phrases, phrase => phrase == "budget review");
        Assert.Equal("Budget review", set.Originals["budget review"]);
    }

    [Fact]
    public void The_phrase_count_never_exceeds_its_ceiling_and_says_when_it_was_cut()
    {
        var text = new StringBuilder();
        for (var index = 0; text.Length < 3990; index++)
        {
            text.Append('w').Append(index.ToString(CultureInfo.InvariantCulture)).Append(' ');
        }

        var set = MentionPhrases.Extract(text.ToString());

        Assert.Equal(MentionPhrases.MaximumPhrases, set.Phrases.Count);
        Assert.True(set.Capped);
    }

    [Fact]
    public void A_whole_passage_of_ordinary_prose_at_the_text_ceiling_is_matched_in_full()
    {
        // Six-letter words and a sentence break every dozen: about 570 words in 4,000 characters,
        // which is denser than most prose. The cap exists for pathological text, not for this.
        var text = new StringBuilder();
        for (var index = 0; text.Length < 3990; index++)
        {
            text.Append("wd").Append((index % 9000).ToString("D4", CultureInfo.InvariantCulture));
            text.Append(index % 12 == 11 ? ". " : " ");
        }

        var set = MentionPhrases.Extract(text.ToString());

        Assert.False(set.Capped);
        Assert.Equal(4000, MentionPhrases.MaximumPhrases);
    }

    [Fact]
    public void Ordinary_prose_is_not_reported_as_cut()
    {
        var set = MentionPhrases.Extract("A short paragraph about the garden and the roses in it.");

        Assert.False(set.Capped);
    }

    [Fact]
    public void Blank_text_yields_nothing()
    {
        var set = MentionPhrases.Extract("   \n\t ");

        Assert.Empty(set.Phrases);
        Assert.False(set.Capped);
    }

    [Fact]
    public void An_overlong_token_cannot_become_a_phrase()
    {
        var set = MentionPhrases.Extract(new string('x', MentionPhrases.MaximumPhraseLength + 1) + " tail");

        Assert.All(set.Phrases, phrase => Assert.True(phrase.Length <= MentionPhrases.MaximumPhraseLength));
        Assert.Contains("tail", set.Phrases);
    }
}
