using System.Globalization;
using Nix.Domain.Calendar;

namespace Nix.Domain.Recurrence;

/// <summary>An occurrence a series produces, as the calendar draws it.</summary>
/// <param name="Entry">The dated entry, carrying the occurrence's own day as its value.</param>
/// <param name="Completed">Whether this occurrence has been ticked off.</param>
public sealed record GeneratedOccurrence(CalendarEntry Entry, bool Completed);

/// <summary>What a merge produced, and what it had to leave out.</summary>
/// <param name="Occurrences">The generated occurrences, in the merged order.</param>
/// <param name="Truncated">
/// True when the merge stopped at its ceiling - there are more entries than were returned.
/// </param>
public sealed record MergedOccurrences(
    IReadOnlyList<GeneratedOccurrence> Occurrences,
    bool Truncated);

/// <summary>
/// Merges the occurrences of many series into a calendar window, under one ceiling.
/// </summary>
/// <remarks>
/// <para>
/// <b>Bounded by construction, not by trimming afterwards.</b> Five hundred candidate series over
/// a four-hundred-day window is two hundred thousand possible occurrences; generating them to
/// return two thousand would be the whole cost of the feature for none of the benefit. Every
/// series is a lazy ascending generator, and the merge pulls from whichever one is furthest behind
/// until the ceiling is met - so nothing advances past what is taken from it.
/// </para>
/// <para>
/// <b>Why truncating the concrete entries first is still correct.</b> The calendar statement
/// applies its own limit before any rule is known, so the merge sees at most the first N concrete
/// entries. That is lossless for the union: if a concrete entry was dropped by the SQL limit, then
/// N concrete entries sort before it, so at least N union members sort before it, so it cannot be
/// in the union's first N either. Stated here because the opposite reading - that the ceiling is
/// spent before recurrences are considered - is plausible and wrong, and somebody will otherwise
/// "fix" it.
/// </para>
/// </remarks>
public static class RecurrenceMerge
{
    /// <summary>
    /// The occurrences every candidate produces in the window, ascending, up to a ceiling.
    /// </summary>
    /// <param name="candidates">The repeating items.</param>
    /// <param name="from">The window's first day, inclusive.</param>
    /// <param name="to">The window's last day, inclusive.</param>
    /// <param name="ceiling">The most occurrences to produce.</param>
    /// <returns>The occurrences and whether more existed.</returns>
    /// <remarks>
    /// Ordered by day, then by the order the candidates arrived - which is the workspace's own
    /// sibling order, so the same window cuts the same occurrences twice.
    /// </remarks>
    public static MergedOccurrences Expand(
        IReadOnlyList<RecurringItem> candidates,
        DateOnly from,
        DateOnly to,
        int ceiling)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        ArgumentOutOfRangeException.ThrowIfNegative(ceiling);

        var streams = new List<Stream>(candidates.Count);
        foreach (var candidate in candidates)
        {
            if (!candidate.CanExpand)
            {
                continue;
            }

            var days = RecurrenceExpansion
                .Occurrences(candidate.Rule!, candidate.Anchor!.Value, from, to)
                .GetEnumerator();

            if (days.MoveNext())
            {
                streams.Add(new Stream(candidate, days));
            }
            else
            {
                days.Dispose();
            }
        }

        var merged = new List<GeneratedOccurrence>();
        try
        {
            while (streams.Count > 0)
            {
                if (merged.Count == ceiling)
                {
                    // Something is still pending, so the answer is short by at least one.
                    return new MergedOccurrences(merged, Truncated: true);
                }

                var next = 0;
                for (var index = 1; index < streams.Count; index++)
                {
                    if (streams[index].Current < streams[next].Current)
                    {
                        next = index;
                    }
                }

                var stream = streams[next];
                var day = stream.Current;
                merged.Add(Occurrence(stream.Candidate, day));

                if (!stream.Advance())
                {
                    stream.Dispose();
                    streams.RemoveAt(next);
                }
            }
        }
        finally
        {
            foreach (var stream in streams)
            {
                stream.Dispose();
            }
        }

        return new MergedOccurrences(merged, Truncated: false);
    }

    private static GeneratedOccurrence Occurrence(RecurringItem candidate, DateOnly day)
    {
        var value = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        return new GeneratedOccurrence(
            new CalendarEntry(
                candidate.ItemId,
                candidate.ItemTitle,
                candidate.ContainerId,
                candidate.ContainerTitle,
                candidate.DateProperty,
                value),
            candidate.Rule!.IsCompleted(day));
    }

    /// <summary>One series' occurrences, positioned at the next one it has not yielded.</summary>
    private sealed class Stream : IDisposable
    {
        private readonly IEnumerator<DateOnly> _days;

        public Stream(RecurringItem candidate, IEnumerator<DateOnly> days)
        {
            Candidate = candidate;
            _days = days;
            Current = days.Current;
        }

        public RecurringItem Candidate { get; }

        public DateOnly Current { get; private set; }

        public bool Advance()
        {
            if (!_days.MoveNext())
            {
                return false;
            }

            Current = _days.Current;
            return true;
        }

        public void Dispose() => _days.Dispose();
    }
}
