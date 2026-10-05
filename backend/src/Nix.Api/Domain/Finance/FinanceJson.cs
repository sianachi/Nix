using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Finance;

/// <summary>Defensive readers over a stored property bag.</summary>
/// <remarks>
/// A stored bag can be anything a client was allowed to write, so every read here answers "the
/// value, or null" and never throws. Callers decide whether null means unset or malformed.
/// </remarks>
public static class FinanceJson
{
    /// <summary>The bag, or an empty one when the JSON is missing or unreadable.</summary>
    public static JsonObject Bag(string? json)
    {
        try
        {
            return JsonNode.Parse(json ?? "{}") as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static bool Has(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        return bag.ContainsKey(key) && bag[key] is not null;
    }

    public static string? Text(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        try
        {
            return bag[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    public static decimal? Amount(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        try
        {
            if (bag[key] is not JsonValue value)
            {
                return null;
            }
            if (value.TryGetValue<decimal>(out var number))
            {
                return number;
            }
            // A number written by a client as a double still has to read back as money.
            return value.TryGetValue<double>(out var real) && double.IsFinite(real) ? (decimal)real : null;
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException)
        {
            return null;
        }
    }

    public static int? Whole(JsonObject bag, string key)
    {
        var number = Amount(bag, key);
        return number is { } value && value == decimal.Truncate(value) && value is >= int.MinValue and <= int.MaxValue ? (int)value : null;
    }

    public static bool? Bool(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        try
        {
            return bag[key] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    public static Guid? Id(JsonObject bag, string key) =>
        Text(bag, key) is { } text && Guid.TryParseExact(text, "D", out var id) ? id : null;

    public static DateOnly? Date(JsonObject bag, string key) =>
        Text(bag, key) is { } text
        && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null;

    public static YearMonth? Month(JsonObject bag, string key) =>
        YearMonth.TryParse(Text(bag, key), out var month) ? month : null;

    public static string DateText(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Reads a <c>{"yyyy-MM": amount}</c> object; a malformed member makes the whole map null.</summary>
    public static IReadOnlyDictionary<YearMonth, decimal>? MonthAmounts(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        if (!Has(bag, key))
        {
            return new Dictionary<YearMonth, decimal>();
        }
        if (bag[key] is not JsonObject map)
        {
            return null;
        }
        var result = new Dictionary<YearMonth, decimal>();
        foreach (var (month, node) in map)
        {
            if (!YearMonth.TryParse(month, out var parsed) || node is null || Amount(map, month) is not { } amount || !MoneyRules.IsAmount(amount))
            {
                return null;
            }
            result[parsed] = amount;
        }
        return result;
    }

    public static JsonObject WriteMonthAmounts(IReadOnlyDictionary<YearMonth, decimal> amounts)
    {
        var map = new JsonObject();
        foreach (var (month, amount) in amounts.OrderBy(pair => pair.Key))
        {
            map[month.ToString()] = amount;
        }
        return map;
    }

    /// <summary>Reads an array of <c>yyyy-MM</c> strings; a malformed member makes the list null.</summary>
    public static IReadOnlyList<YearMonth>? Months(JsonObject bag, string key)
    {
        ArgumentNullException.ThrowIfNull(bag);
        // A missing field means no months are closed; an explicit JSON null is malformed and
        // must not silently reopen every month.
        if (!bag.ContainsKey(key))
        {
            return [];
        }
        if (bag[key] is not JsonArray array)
        {
            return null;
        }
        var months = new List<YearMonth>();
        foreach (var node in array)
        {
            try
            {
                if (node is not JsonValue value || !value.TryGetValue<string>(out var text) || !YearMonth.TryParse(text, out var month))
                {
                    return null;
                }
                months.Add(month);
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }
        return months;
    }

    public static JsonArray WriteMonths(IEnumerable<YearMonth> months) =>
        new(months.Distinct().OrderBy(month => month).Select(month => (JsonNode?)JsonValue.Create(month.ToString())).ToArray());
}

/// <summary>What an amount of money may be.</summary>
/// <remarks>
/// A decimal with at most two fractional digits, in one workspace currency, below a billion in
/// magnitude. Arithmetic over such values in <see cref="decimal"/> is exact, which is the
/// property a ledger cannot do without and a JSON double cannot promise.
/// </remarks>
public static class MoneyRules
{
    public const decimal Maximum = 999_999_999.99m;

    // Compare against the bounded range directly: Math.Abs(decimal.MinValue) overflows before
    // malformed stored data or an adversarial request can be rejected cleanly.
    public static bool IsAmount(decimal value) => value >= -Maximum && value <= Maximum && decimal.Round(value, 2) == value;

    /// <summary>Rounds half away from zero to two places, the way a statement does.</summary>
    public static decimal Round(decimal value) => decimal.Round(value, 2, MidpointRounding.AwayFromZero);

    public static bool IsCurrency(string? code) => code is { Length: 3 } && code.All(char.IsAsciiLetterUpper);
}
