using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Habits;

/// <summary>Habit semantics carried by an ordinary item's property bag.</summary>
public sealed record HabitSettings(string Frequency, IReadOnlyList<int> Weekdays, string Timezone, DateOnly StartDate, decimal Target, string Unit)
{
    /// <summary>Upper bound shared by targets and daily quantities.</summary>
    public const decimal MaximumQuantity = 1_000_000;

    /// <summary>Whether a local day is planned.</summary>
    public bool IsScheduled(DateOnly day) => day >= StartDate && (Frequency == "daily" || Weekdays.Contains((int)day.DayOfWeek));

    /// <summary>The local date in the saved timezone.</summary>
    public DateOnly Today(DateTimeOffset now) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(Timezone)).DateTime);

    /// <summary>Checks a schedule before it is written or used from untrusted stored properties.</summary>
    public string? Validate()
    {
        if (Frequency is not ("daily" or "weekly"))
        {
            return "Choose a daily or selected-weekday schedule.";
        }
        if (Target is <= 0 or > MaximumQuantity)
        {
            return "Target must be greater than zero and no more than one million.";
        }
        if (string.IsNullOrWhiteSpace(Unit) || Unit.Length > 32)
        {
            return "A unit of at most 32 characters is required.";
        }
        if (string.IsNullOrWhiteSpace(Timezone) || Timezone.Length > 128 || !TimeZoneInfo.TryFindSystemTimeZoneById(Timezone, out _))
        {
            return "Choose a valid timezone.";
        }
        if (Weekdays.Count > 7 || Weekdays.Any(day => day is < 0 or > 6) || Weekdays.Distinct().Count() != Weekdays.Count)
        {
            return "Weekdays must be unique numbers from zero (Sunday) to six (Saturday).";
        }
        if ((Frequency == "daily" && Weekdays.Count != 0) || (Frequency == "weekly" && Weekdays.Count == 0))
        {
            return "Daily habits have no weekday selection; weekly habits need at least one weekday.";
        }
        return null;
    }

    /// <summary>Settings can be saved again unchanged without rewriting history.</summary>
    public bool SameSchedule(HabitSettings other)
    {
        ArgumentNullException.ThrowIfNull(other);
        return Frequency == other.Frequency && Weekdays.Order().SequenceEqual(other.Weekdays.Order()) && Timezone == other.Timezone && StartDate == other.StartDate && Target == other.Target && Unit == other.Unit;
    }

    /// <summary>Property changes, merged by the ordinary property writer.</summary>
    public JsonObject ToProperties() => new()
    {
        ["$habit_frequency"] = Frequency,
        ["$habit_weekdays"] = new JsonArray(Weekdays.Select(day => (JsonNode?)JsonValue.Create(day)).ToArray()),
        ["$habit_timezone"] = Timezone,
        ["$habit_start_date"] = StartDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        ["$habit_target"] = Target,
        ["$habit_unit"] = Unit,
    };

    /// <summary>Generic property edits must never turn malformed settings into a successful empty tracker.</summary>
    public static HabitSettings? Read(string? json)
    {
        try
        {
            var bag = JsonNode.Parse(json ?? "{}") as JsonObject;
            if (bag?["$habit_frequency"]?.GetValue<string>() is not { } frequency
                || bag["$habit_timezone"]?.GetValue<string>() is not { } timezone
                || bag["$habit_start_date"]?.GetValue<string>() is not { } date
                || !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var start)
                || bag["$habit_target"]?.GetValue<decimal>() is not { } target
                || bag["$habit_unit"]?.GetValue<string>() is not { } unit)
            {
                return null;
            }
            var days = bag["$habit_weekdays"]?.AsArray().Select(node => node!.GetValue<int>()).ToArray() ?? [];
            var settings = new HabitSettings(frequency, days, timezone, start, target, unit);
            return settings.Validate() is null ? settings : null;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException or NullReferenceException)
        {
            return null;
        }
    }

    /// <summary>Reads the schedule version effective on a local date.</summary>
    public static HabitSettings? ReadForDay(string? json, DateOnly day) => HabitHistory.Read(json)?.SettingsOn(day);
}
