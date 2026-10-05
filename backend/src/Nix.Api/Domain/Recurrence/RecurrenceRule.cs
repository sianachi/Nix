using System.Collections.Immutable;

namespace Nix.Domain.Recurrence;

/// <summary>How often a series repeats.</summary>
public enum RecurrenceFrequency
{
    /// <summary>Every <c>Interval</c> days.</summary>
    Daily = 0,

    /// <summary>Every <c>Interval</c> weeks, optionally on named weekdays.</summary>
    Weekly = 1,

    /// <summary>Every <c>Interval</c> months, clamped to the month's last day.</summary>
    Monthly = 2,

    /// <summary>Every <c>Interval</c> years, Feb 29 clamped to Feb 28 off leap years.</summary>
    Yearly = 3,
}

/// <summary>
/// A repeating rule on an item: a deliberate subset of RRULE, anchored to the item's own due date.
/// </summary>
/// <remarks>
/// <para>
/// <b>All days, no times, no zones.</b> The anchor is a day, occurrences are days, and the
/// calendar windows by day - so no DST question ever arises, which is the point of anchoring on
/// the day rather than a moment.
/// </para>
/// <para>
/// <b>Completion state lives inside the rule, deliberately.</b> Calendar expansion needs the rule
/// and its completions as one instant's truth; a second read could disagree with the first, and
/// an occurrence rendered open when it was just completed is a defect the client can only draw as
/// nonsense. One column makes the disagreement unexpressible. The cost - rewriting the row per
/// completion - is paid at human frequency on a row the write touches anyway.
/// </para>
/// <para>
/// <c>CompletedThrough</c> is the watermark (every occurrence at or before it is complete) and
/// <c>Completed</c> the exceptions above it, sorted ascending. Both are needed: the watermark
/// collapses in-order completion to O(1), the list handles out-of-order completion.
/// </para>
/// </remarks>
/// <param name="Frequency">How often.</param>
/// <param name="Interval">Every how many units, 1..366.</param>
/// <param name="Weekdays">Weekly only: which days, ISO order, non-empty when present.</param>
/// <param name="Until">The last day an occurrence may fall on, inclusive; null for no end.</param>
/// <param name="CompletedThrough">Every occurrence at or before this day is complete.</param>
/// <param name="Completed">Completed occurrence days after the watermark, ascending.</param>
public sealed record RecurrenceRule(
    RecurrenceFrequency Frequency,
    int Interval,
    ImmutableArray<IsoDayOfWeek> Weekdays,
    DateOnly? Until,
    DateOnly? CompletedThrough,
    ImmutableArray<DateOnly> Completed)
{
    /// <summary>Whether the occurrence on <paramref name="day"/> has been completed.</summary>
    /// <param name="day">The occurrence day.</param>
    /// <returns><see langword="true"/> when at or below the watermark or listed.</returns>
    public bool IsCompleted(DateOnly day) =>
        (CompletedThrough is { } through && day <= through) || Completed.Contains(day);

    /// <summary>Whether two rules say the same thing.</summary>
    /// <param name="other">The rule to compare with.</param>
    /// <returns><see langword="true"/> when every field matches, sequences by value.</returns>
    /// <remarks>
    /// Written out because a record compares <see cref="ImmutableArray{T}"/> by reference, so the
    /// generated equality would call two rules with identical weekdays different - which is the
    /// wrong answer everywhere it matters: a round trip through storage, and "did this write
    /// change anything".
    /// </remarks>
    public bool Equals(RecurrenceRule? other) =>
        other is not null
        && Frequency == other.Frequency
        && Interval == other.Interval
        && Until == other.Until
        && CompletedThrough == other.CompletedThrough
        && Weekdays.AsSpan().SequenceEqual(other.Weekdays.AsSpan())
        && Completed.AsSpan().SequenceEqual(other.Completed.AsSpan());

    /// <inheritdoc />
    public override int GetHashCode()
    {
        var hash = default(HashCode);
        hash.Add(Frequency);
        hash.Add(Interval);
        hash.Add(Until);
        hash.Add(CompletedThrough);
        foreach (var weekday in Weekdays)
        {
            hash.Add(weekday);
        }

        foreach (var day in Completed)
        {
            hash.Add(day);
        }

        return hash.ToHashCode();
    }
}

/// <summary>Weekday names as the rule stores them, ISO-numbered so Monday is first.</summary>
/// <remarks>
/// The values are ISO-8601 weekday numbers, and <see cref="RecurrenceExpansion"/> does arithmetic
/// with them (<c>weekStart.AddDays((int)weekday - 1)</c>). There is no zero member on purpose:
/// zero is not a weekday, and a "None" that could reach the arithmetic would place an occurrence
/// on the Sunday before the week it belongs to.
/// </remarks>
// Justification: see the remarks - ISO numbering is the point, and a zero member would be a
// weekday that is not a weekday, reachable by the day arithmetic above.
#pragma warning disable CA1008
public enum IsoDayOfWeek
#pragma warning restore CA1008
{
    /// <summary>Monday.</summary>
    Monday = 1,

    /// <summary>Tuesday.</summary>
    Tuesday = 2,

    /// <summary>Wednesday.</summary>
    Wednesday = 3,

    /// <summary>Thursday.</summary>
    Thursday = 4,

    /// <summary>Friday.</summary>
    Friday = 5,

    /// <summary>Saturday.</summary>
    Saturday = 6,

    /// <summary>Sunday.</summary>
    Sunday = 7,
}
