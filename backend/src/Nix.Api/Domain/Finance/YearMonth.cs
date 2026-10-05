using System.Globalization;

namespace Nix.Domain.Finance;

/// <summary>A calendar month, the unit every budget figure is planned and totalled in.</summary>
/// <remarks>
/// Written and parsed as <c>yyyy-MM</c> everywhere it crosses a boundary, so a month read back from
/// a property or a route is the month that was written, in every timezone.
/// </remarks>
public readonly record struct YearMonth(int Year, int Month) : IComparable<YearMonth>
{
    /// <summary>Months since year zero; the arithmetic form of the value.</summary>
    public int Index => (Year * 12) + Month - 1;

    /// <summary>The first day of the month.</summary>
    public DateOnly FirstDay => new(Year, Month, 1);

    /// <summary>The last day of the month.</summary>
    public DateOnly LastDay => new(Year, Month, DateTime.DaysInMonth(Year, Month));

    /// <summary>The month a day falls in.</summary>
    public static YearMonth Of(DateOnly day) => new(day.Year, day.Month);

    /// <summary>The month at an index produced by <see cref="Index"/>.</summary>
    public static YearMonth FromIndex(int index) => new(Math.DivRem(index, 12, out var month), month + 1);

    /// <summary>This month moved by a number of months, negative to go back.</summary>
    public YearMonth AddMonths(int months) => FromIndex(Index + months);

    /// <summary>Every month from <paramref name="from"/> to <paramref name="to"/> inclusive, in order.</summary>
    public static IEnumerable<YearMonth> Range(YearMonth from, YearMonth to)
    {
        for (var index = from.Index; index <= to.Index; index++)
        {
            yield return FromIndex(index);
        }
    }

    /// <summary>Parses <c>yyyy-MM</c>; anything else is refused rather than guessed at.</summary>
    public static bool TryParse(string? text, out YearMonth month)
    {
        month = default;
        if (text is null || text.Length != 7 || text[4] != '-'
            || !int.TryParse(text.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year)
            || !int.TryParse(text.AsSpan(5, 2), NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            || year is < 1 or > 9999 || number is < 1 or > 12)
        {
            return false;
        }
        month = new YearMonth(year, number);
        return true;
    }

    /// <summary>A day of this month, clamping a day number past the month's end to its last day.</summary>
    public DateOnly Day(int day) => new(Year, Month, Math.Clamp(day, 1, DateTime.DaysInMonth(Year, Month)));

    /// <inheritdoc />
    public int CompareTo(YearMonth other) => Index.CompareTo(other.Index);

    /// <inheritdoc />
    public override string ToString() => string.Create(CultureInfo.InvariantCulture, $"{Year:D4}-{Month:D2}");

    public static bool operator <(YearMonth left, YearMonth right) => left.Index < right.Index;
    public static bool operator >(YearMonth left, YearMonth right) => left.Index > right.Index;
    public static bool operator <=(YearMonth left, YearMonth right) => left.Index <= right.Index;
    public static bool operator >=(YearMonth left, YearMonth right) => left.Index >= right.Index;
}
