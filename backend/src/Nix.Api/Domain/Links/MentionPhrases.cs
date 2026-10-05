using System.Globalization;
using System.Text;

namespace Nix.Domain.Links;

/// <summary>
/// Cuts a passage of text into the word phrases a title could equal, so mention matching is one
/// equality probe against a bounded array rather than a pattern per title.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the server cuts the phrases rather than the client sending them.</b> A client that sent
/// its own phrase list would be choosing how many probes the statement makes and what they look
/// like. Cut here, the shape and the count of the array are properties of this class, and the only
/// thing a caller controls is the text - which is bounded before it reaches this class.
/// </para>
/// <para>
/// <b>A word</b> is a run of non-whitespace with any leading and trailing characters that are
/// neither letters nor digits stripped off, so <c>"Atlas,"</c> is the word <c>atlas</c> and
/// <c>"Node.js"</c> keeps its inner full stop. <b>A phrase</b> is one to <see cref="MaximumWords"/>
/// consecutive words joined by single spaces and lower-cased. Phrases never span a line break, or
/// a word that lost punctuation at the joining edge: <c>"I met Alice. Smith arrived"</c> must not
/// produce <c>alice smith</c>, because that sentence does not mention a document called that.
/// </para>
/// <para>
/// Single words shorter than <see cref="MinimumSingleWordLength"/> characters, and phrases made
/// only of numbers, are skipped: a workspace with a note called "Q3" or "2024" would otherwise be
/// "mentioned" by most of the prose anybody writes, and a suggestion that fires on everything is
/// one people learn to ignore.
/// </para>
/// <para>
/// Lower-casing is invariant-culture here and <c>lower()</c> under the database collation in the
/// statement. The two agree for the scripts people title notes in; where they would not (a
/// locale-specific casing rule), the cost is a missed suggestion, never a wrong one, because the
/// statement can only return titles equal to a phrase this class produced.
/// </para>
/// </remarks>
public static class MentionPhrases
{
    /// <summary>The longest phrase considered, in words.</summary>
    public const int MaximumWords = 6;

    /// <summary>The shortest single word considered, in characters.</summary>
    public const int MinimumSingleWordLength = 4;

    /// <summary>The longest phrase considered, in characters, so one long token cannot bloat the array.</summary>
    public const int MaximumPhraseLength = 200;

    /// <summary>
    /// The most distinct phrases one passage yields; later phrases are dropped and the set says so.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Sized so the largest accepted passage of ordinary prose is matched in full. Four thousand
    /// characters of prose is roughly 600 to 700 words; each word starts up to
    /// <see cref="MaximumWords"/> phrases, sentence punctuation and line breaks end them early, and
    /// short single words are skipped, which comes to between about 2,700 and 4,000 distinct
    /// n-grams. Four thousand therefore covers ordinary prose, and a client can trust a passage
    /// that comes back uncapped.
    /// </para>
    /// <para>
    /// Only pathological text meets the cap - one- and two-letter words with no punctuation reach
    /// about 10,000 n-grams in the same length - and then the tail is dropped and the answer is
    /// marked <c>truncated</c> so the client re-sends the uncovered text later. The array parameter
    /// is then at most about 4,000 short strings (a few tens of kilobytes); the statement hashes
    /// it, so its cost is dominated by the workspace scan rather than by this number.
    /// </para>
    /// </remarks>
    public const int MaximumPhrases = 4000;

    /// <summary>Cuts <paramref name="text"/> into distinct candidate phrases, in first-seen order.</summary>
    /// <param name="text">The passage, already bounded by the caller.</param>
    /// <returns>The phrases, where each first appeared, and whether the cap cut the list short.</returns>
    public static MentionPhraseSet Extract(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var normalised = text.Normalize(NormalizationForm.FormC);
        var words = Tokenise(normalised);

        var phrases = new List<string>();
        var originals = new Dictionary<string, string>(StringComparer.Ordinal);
        var capped = false;
        var builder = new StringBuilder();

        for (var first = 0; first < words.Count && !capped; first++)
        {
            builder.Clear();
            var allNumeric = true;

            for (var last = first; last < words.Count && last - first < MaximumWords; last++)
            {
                var word = words[last];
                if (last > first)
                {
                    // A phrase ends where the text breaks: a line break, or punctuation stripped
                    // from either side of the join.
                    if (words[last - 1].BreaksAfter || word.BreaksBefore)
                    {
                        break;
                    }

                    builder.Append(' ');
                }

                builder.Append(word.Lowered);
                allNumeric &= word.IsNumeric;

                if (builder.Length > MaximumPhraseLength)
                {
                    break;
                }

                var wordCount = last - first + 1;
                if (allNumeric || (wordCount == 1 && word.Lowered.Length < MinimumSingleWordLength))
                {
                    continue;
                }

                var phrase = builder.ToString();
                if (originals.ContainsKey(phrase))
                {
                    continue;
                }

                if (phrases.Count == MaximumPhrases)
                {
                    capped = true;
                    break;
                }

                phrases.Add(phrase);
                originals.Add(phrase, normalised[words[first].Start..word.End]);
            }
        }

        return new MentionPhraseSet(phrases, originals, capped);
    }

    private static List<Word> Tokenise(string text)
    {
        var words = new List<Word>();
        var index = 0;
        var lineBreakPending = false;

        while (index < text.Length)
        {
            if (char.IsWhiteSpace(text[index]))
            {
                lineBreakPending |= text[index] is '\n' or '\r' or '\u2028' or '\u2029';
                index++;
                continue;
            }

            var chunkStart = index;
            while (index < text.Length && !char.IsWhiteSpace(text[index]))
            {
                index++;
            }

            var chunkEnd = index;
            var start = chunkStart;
            var end = chunkEnd;
            while (start < end && !char.IsLetterOrDigit(text[start]))
            {
                start++;
            }

            while (end > start && !char.IsLetterOrDigit(text[end - 1]))
            {
                end--;
            }

            if (start == end)
            {
                // Pure punctuation ("-", "...") separates phrases rather than joining them.
                if (words.Count > 0)
                {
                    words[^1] = words[^1] with { BreaksAfter = true };
                }

                continue;
            }

            if (lineBreakPending && words.Count > 0)
            {
                words[^1] = words[^1] with { BreaksAfter = true };
            }

            lineBreakPending = false;
#pragma warning disable CA1308 // Normalize strings to uppercase
            // Justification: the phrase is compared for equality with lower(title) in Postgres, so
            // it has to be lower-cased the same direction; upper-casing would never match.
            var lowered = text[start..end].ToLowerInvariant();
#pragma warning restore CA1308
            words.Add(new Word(
                start,
                end,
                lowered,
                IsNumeric(lowered),
                BreaksBefore: start > chunkStart,
                BreaksAfter: end < chunkEnd));
        }

        return words;
    }

    private static bool IsNumeric(string word)
    {
        foreach (var character in word)
        {
            if (!char.IsDigit(character)
                && CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.OtherPunctuation)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>One word, where it sits in the text, and whether the text breaks around it.</summary>
    private readonly record struct Word(
        int Start,
        int End,
        string Lowered,
        bool IsNumeric,
        bool BreaksBefore,
        bool BreaksAfter);
}

/// <summary>
/// The phrases one passage yielded.
/// </summary>
/// <param name="Phrases">Distinct normalised phrases, in the order they first appear.</param>
/// <param name="Originals">
/// Each phrase's first occurrence as it appears in the text (after Unicode NFC normalisation), so a
/// client can find it again without re-implementing the cut.
/// </param>
/// <param name="Capped">
/// Whether <see cref="MentionPhrases.MaximumPhrases"/> cut the list short, so the rest of the text
/// was not considered. A caller reports this as a partial answer rather than a complete one.
/// </param>
public sealed record MentionPhraseSet(
    IReadOnlyList<string> Phrases,
    IReadOnlyDictionary<string, string> Originals,
    bool Capped);
