using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>How a chart view draws its buckets.</summary>
/// <remarks>
/// <para>
/// <b>The same buckets under every type.</b> The type is a drawing decision, so it changes nothing
/// the server computes except for <see cref="Year"/>, which always counts by day. Stored as text like
/// every other vocabulary here.
/// </para>
/// <para>
/// <b>Line, area and the year grid need an ordered axis</b>, so they are refused on write without a
/// period (<see cref="ViewDefinitionRules"/>): a line through categories joins values that have no
/// order, and the reader takes the slope for a trend.
/// </para>
/// </remarks>
public static class ChartKinds
{
    /// <summary>Horizontal bars, the type every chart stored before the field existed draws.</summary>
    public const string Bar = "bar";

    /// <summary>Vertical columns; stacked when the chart is split into series.</summary>
    public const string Column = "column";

    /// <summary>Shares of the whole.</summary>
    public const string Pie = "pie";

    /// <summary>A line along a time axis, one per series.</summary>
    public const string Line = "line";

    /// <summary>A filled line along a time axis, stacked when split into series.</summary>
    public const string Area = "area";

    /// <summary>A 53-week grid of days, each shaded by its value.</summary>
    public const string Year = "year";

    /// <summary>Every type this build draws, in the order an editor offers them.</summary>
    public static readonly ImmutableArray<string> All = [Bar, Column, Pie, Line, Area, Year];

    /// <summary>Whether a stored or requested value names a type this build draws.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of <see cref="All"/>.</returns>
    public static bool IsValid(string value) => All.Contains(value, StringComparer.Ordinal);

    /// <summary>Whether a type only makes sense along an ordered, dated axis.</summary>
    /// <param name="value">The type.</param>
    /// <returns><see langword="true"/> for line, area and the year grid.</returns>
    public static bool NeedsTimeAxis(string? value) =>
        value is Line or Area or Year;
}

/// <summary>
/// A chart view's drawing options beyond what it groups by and measures.
/// </summary>
/// <param name="Kind">
/// One of <see cref="ChartKinds.All"/>, or <see langword="null"/> for a bar chart - what every chart
/// stored before this field existed draws, so absent keeps meaning it.
/// </param>
/// <param name="Period">
/// One of <see cref="ChartPeriods.All"/> when the grouping property is a date and the chart has a
/// time axis; <see langword="null"/> for a chart of categories.
/// </param>
/// <param name="SplitBy">
/// A second property whose values split each bucket into series (stacked or grouped columns, one
/// line per value), or <see langword="null"/> for one series. A property with few values in practice;
/// not checked here, for the reason <see cref="ViewDefinition.CanRender"/> gives - the write path
/// has no schema.
/// </param>
/// <param name="LastPeriods">
/// A rolling window: the most recent this many periods, the current one included. Exclusive with
/// <paramref name="From"/> and <paramref name="To"/>.
/// </param>
/// <param name="From">A fixed window's first day, snapped back to the start of its period.</param>
/// <param name="To">A fixed window's last day, snapped forward to the end of its period.</param>
/// <param name="Cumulative">Line and area: draw the running total rather than each period's value.</param>
/// <param name="RollingAverage">Line and area: add the trailing seven-period average.</param>
/// <remarks>
/// <para>
/// <b>One nested record rather than eight more flat fields on the view.</b> The view record is flat
/// by history (<see cref="ViewDefinition"/>), and every field threaded through it costs an edit in
/// each of its contracts, readers and writers. Per-kind detail that only one kind reads already
/// nests - <see cref="InteractiveFormDefinition"/>, the habit widgets - and this follows them.
/// <c>GroupBy</c>, <c>Measure</c> and <c>MeasureProperty</c> stay where they are, because a board
/// shares the first and every stored chart already carries the other two.
/// </para>
/// <para>
/// The two line toggles are computed by the renderer over the buckets the server returns; they are
/// stored here so a chart opens the way it was left, not because the server reads them.
/// </para>
/// </remarks>
public sealed record ChartOptions(
    string? Kind = null,
    string? Period = null,
    string? SplitBy = null,
    int? LastPeriods = null,
    DateOnly? From = null,
    DateOnly? To = null,
    bool Cumulative = false,
    bool RollingAverage = false)
{
    /// <summary>The most periods a time axis draws: 53 weeks of days, exactly one year grid.</summary>
    /// <remarks>
    /// A ceiling rather than a refusal, like the category chart's bucket ceiling: a daily axis over
    /// ten years of entries is three thousand points nobody can read, so the most recent periods are
    /// drawn and the response says how many were left out. Large enough for a leap year of days.
    /// </remarks>
    public const int MaximumPeriods = 371;

    /// <summary>Whether these options say nothing a default chart would not.</summary>
    public bool IsEmpty => this == Default;

    /// <summary>The options a chart with nothing configured draws with.</summary>
    public static ChartOptions Default { get; } = new();

    /// <summary>The first reason these options cannot be stored, or <see langword="null"/>.</summary>
    /// <returns>A clause finishing "'&lt;view name&gt;': ...".</returns>
    public string? Refuse()
    {
        if (Kind is { } kind && !ChartKinds.IsValid(kind))
        {
            return $"'{kind}' is not a chart type; use one of {string.Join(", ", ChartKinds.All)}";
        }

        ChartPeriod? period = null;
        if (Period is { } text)
        {
            if (!ChartPeriods.TryParse(text, out var parsed))
            {
                return $"'{text}' is not a period; use one of {string.Join(", ", ChartPeriods.All)}";
            }

            period = parsed;
        }

        if (ChartKinds.NeedsTimeAxis(Kind) && period is null)
        {
            return $"a {Kind} chart runs along dates, so it needs a date to group by and a period";
        }

        if (Kind == ChartKinds.Year && period != ChartPeriod.Day)
        {
            return "a year grid counts by day; set its period to day";
        }

        if (SplitBy is { Length: 0 or > ViewDefinitionRules.MaximumKeyLength })
        {
            return "the property to split by must be named, in at most "
                + $"{ViewDefinitionRules.MaximumKeyLength} characters";
        }

        var windowed = LastPeriods is not null || From is not null || To is not null;
        if (windowed && period is null)
        {
            return "a window of periods needs a period to count in";
        }

        if (LastPeriods is { } last)
        {
            if (From is not null || To is not null)
            {
                return "a window is either the last few periods or a range of dates, not both";
            }

            if (last is < 1 or > MaximumPeriods)
            {
                return $"a window may hold from 1 to {MaximumPeriods} periods";
            }
        }

        if ((From is { } from && !ChartPeriods.IsInRange(from))
            || (To is { } to && !ChartPeriods.IsInRange(to)))
        {
            return "a window's dates must fall between the years 2 and 9998";
        }

        if (From is { } start && To is { } end && end < start)
        {
            return "a window must end on or after the day it starts";
        }

        return null;
    }
}
