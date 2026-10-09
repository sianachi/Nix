using System.Globalization;
using System.Text.Json.Nodes;

namespace Nix.Domain.Views;

/// <summary>
/// Stores a chart view's <see cref="ChartOptions"/> as the <c>chart</c> object of its view entry.
/// </summary>
/// <remarks>
/// <para>
/// Kept apart from <see cref="ViewDefinitionsJson"/> so that file gains two calls rather than a
/// third per-kind block, and with its contract: written sparsely, so a chart nobody configured
/// stores no <c>chart</c> key and every existing row stays byte-identical.
/// </para>
/// <para>
/// <b>Read fail-soft, field by field.</b> A type or period an older build does not know reads as
/// absent - a bar chart, or a chart of categories - rather than costing the view, the same posture
/// the measure reader takes. The write path refuses unknown values, which is where somebody can be
/// told.
/// </para>
/// </remarks>
internal static class ChartOptionsJson
{
    /// <summary>The key the options are stored under on a view entry.</summary>
    internal const string Key = "chart";

    private const string KindKey = "kind";
    private const string PeriodKey = "period";
    private const string SplitByKey = "splitBy";
    private const string LastPeriodsKey = "lastPeriods";
    private const string FromKey = "from";
    private const string ToKey = "to";
    private const string CumulativeKey = "cumulative";
    private const string RollingAverageKey = "rollingAverage";
    private const string DateFormat = "yyyy-MM-dd";

    /// <summary>Writes the options, or nothing when there is nothing to say.</summary>
    /// <param name="options">The options.</param>
    /// <returns>The object to store, or <see langword="null"/> to store no key.</returns>
    internal static JsonObject? Write(ChartOptions? options)
    {
        if (options is null || options.IsEmpty)
        {
            return null;
        }

        var entry = new JsonObject();

        if (options.Kind is not null)
        {
            entry[KindKey] = options.Kind;
        }

        if (options.Period is not null)
        {
            entry[PeriodKey] = options.Period;
        }

        if (options.SplitBy is not null)
        {
            entry[SplitByKey] = options.SplitBy;
        }

        if (options.LastPeriods is { } last)
        {
            entry[LastPeriodsKey] = last;
        }

        if (options.From is { } from)
        {
            entry[FromKey] = from.ToString(DateFormat, CultureInfo.InvariantCulture);
        }

        if (options.To is { } to)
        {
            entry[ToKey] = to.ToString(DateFormat, CultureInfo.InvariantCulture);
        }

        if (options.Cumulative)
        {
            entry[CumulativeKey] = true;
        }

        if (options.RollingAverage)
        {
            entry[RollingAverageKey] = true;
        }

        return entry;
    }

    /// <summary>Reads stored options, dropping any field this build cannot use.</summary>
    /// <param name="node">The stored <c>chart</c> value.</param>
    /// <returns>The options, or <see langword="null"/> when none were stored.</returns>
    internal static ChartOptions? Read(JsonNode? node)
    {
        if (node is not JsonObject stored)
        {
            return null;
        }

        var kind = ReadString(stored[KindKey]) is { } text && ChartKinds.IsValid(text) ? text : null;
        var period = ReadString(stored[PeriodKey]) is { } span && ChartPeriods.TryParse(span, out _)
            ? span
            : null;

        // A type that needs a time axis read without one would be refused on write; reading it as a
        // bar keeps the view drawable rather than handing the chart endpoint a line through categories.
        if (ChartKinds.NeedsTimeAxis(kind) && period is null)
        {
            kind = null;
        }

        var last = stored[LastPeriodsKey] is JsonValue lastValue
            && lastValue.TryGetValue(out int count)
            && count is >= 1 and <= ChartOptions.MaximumPeriods
                ? count
                : (int?)null;

        var options = new ChartOptions(
            kind,
            period,
            ReadString(stored[SplitByKey]) is { Length: > 0 } split ? split : null,
            period is null ? null : last,
            period is null || last is not null ? null : ReadDate(stored[FromKey]),
            period is null || last is not null ? null : ReadDate(stored[ToKey]),
            ReadFlag(stored[CumulativeKey]),
            ReadFlag(stored[RollingAverageKey]));

        // A window whose ends crossed is one no writer here produces; dropping it draws every period
        // rather than none.
        if (options.From is { } from && options.To is { } to && to < from)
        {
            options = options with { From = null, To = null };
        }

        return options.IsEmpty ? null : options;
    }

    private static DateOnly? ReadDate(JsonNode? node) =>
        ReadString(node) is { Length: 10 } text && ChartPeriods.TryReadDate(text, out var date)
            ? date
            : null;

    private static bool ReadFlag(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out bool flag) && flag;

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
