using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Habits;

/// <summary>Effective-date settings and lifecycle history stored with the ordinary habit item.</summary>
public sealed class HabitHistory
{
    private const int MaximumVersions = 512;
    private readonly List<(DateOnly From, HabitSettings Settings)> _settings;
    private readonly List<(DateOnly From, string Status)> _statuses;

    private HabitHistory(List<(DateOnly, HabitSettings)> settings, List<(DateOnly, string)> statuses)
    {
        _settings = settings;
        _statuses = statuses;
    }

    /// <summary>The earliest date on which any saved version starts.</summary>
    public DateOnly Start => _settings.Min(entry => entry.Settings.StartDate);

    /// <summary>The settings effective for a local day.</summary>
    public HabitSettings SettingsOn(DateOnly day) => _settings.LastOrDefault(entry => entry.From <= day, _settings[0]).Settings;

    /// <summary>The lifecycle state effective for a local day.</summary>
    public string StatusOn(DateOnly day) => _statuses.LastOrDefault(entry => entry.From <= day, (From: DateOnly.MinValue, Status: "active")).Status;

    /// <summary>Reads legacy settings as the first version; malformed history fails closed.</summary>
    public static HabitHistory? Read(string? properties)
    {
        try
        {
            var current = HabitSettings.Read(properties);
            if (current is null)
            {
                return null;
            }
            var bag = JsonNode.Parse(properties ?? "{}")!.AsObject();
            var settings = new List<(DateOnly, HabitSettings)>();
            if (bag["$habit_versions"] is JsonArray versions)
            {
                if (versions.Count > MaximumVersions)
                {
                    return null;
                }
                foreach (var node in versions)
                {
                    var entry = node!.AsObject();
                    var value = HabitSettings.Read(entry["settings"]?.ToJsonString());
                    if (value is null)
                    {
                        return null;
                    }
                    settings.Add((ParseDay(entry["effectiveFrom"]), value));
                }
            }
            settings.Add((bag["$habit_effective_from"] is { } effective ? ParseDay(effective) : DateOnly.MinValue, current));
            settings.Sort((left, right) => left.Item1.CompareTo(right.Item1));
            var statuses = new List<(DateOnly, string)> { (DateOnly.MinValue, "active") };
            if (bag["$habit_status_versions"] is JsonArray statusVersions)
            {
                if (statusVersions.Count > MaximumVersions)
                {
                    return null;
                }
                foreach (var node in statusVersions)
                {
                    var entry = node!.AsObject();
                    var status = entry["status"]!.GetValue<string>();
                    if (status is not ("active" or "paused" or "archived"))
                    {
                        return null;
                    }
                    statuses.Add((ParseDay(entry["effectiveFrom"]), status));
                }
            }
            else if (bag["$habit_status"]?.GetValue<string>() is { } legacyStatus)
            {
                if (legacyStatus is not ("active" or "paused" or "archived"))
                {
                    return null;
                }
                statuses[0] = (DateOnly.MinValue, legacyStatus);
            }
            statuses.Sort((left, right) => left.Item1.CompareTo(right.Item1));
            return new HabitHistory(settings, statuses);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException or NullReferenceException)
        {
            return null;
        }
    }

    /// <summary>Appends a prospective settings revision, preserving all older versions.</summary>
    public JsonObject? ChangeSettings(HabitSettings next, DateOnly effective)
    {
        ArgumentNullException.ThrowIfNull(next);
        if (_settings.Count >= MaximumVersions)
        {
            return null;
        }
        var properties = next.ToProperties();
        var versions = new JsonArray();
        foreach (var entry in _settings.Where(entry => entry.From < effective))
        {
            versions.Add(new JsonObject { ["effectiveFrom"] = Format(entry.From), ["settings"] = entry.Settings.ToProperties() });
        }
        properties["$habit_versions"] = versions;
        properties["$habit_effective_from"] = Format(effective);
        return properties;
    }

    /// <summary>Updates today's lifecycle interval; repeated writes are idempotent.</summary>
    public JsonObject? ChangeStatus(string status, DateOnly effective)
    {
        if (_statuses.Count >= MaximumVersions)
        {
            return null;
        }
        var versions = new JsonArray();
        foreach (var entry in _statuses.Where(entry => entry.From < effective))
        {
            versions.Add(new JsonObject { ["effectiveFrom"] = Format(entry.From), ["status"] = entry.Status });
        }
        versions.Add(new JsonObject { ["effectiveFrom"] = Format(effective), ["status"] = status });
        return new JsonObject { ["$habit_status"] = status, ["$habit_status_versions"] = versions };
    }

    private static DateOnly ParseDay(JsonNode? node) => DateOnly.ParseExact(node!.GetValue<string>(), "yyyy-MM-dd", CultureInfo.InvariantCulture);
    private static string Format(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
