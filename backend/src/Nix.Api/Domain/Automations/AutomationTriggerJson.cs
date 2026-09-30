using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Domain.Recurrence;
using NodaTime;
using IsoDayOfWeek = Nix.Domain.Recurrence.IsoDayOfWeek;

namespace Nix.Domain.Automations;

/// <summary>
/// Reads and writes the stored trigger document, schema version 1.
/// </summary>
/// <remarks>
/// <para>
/// <b>Strict both ways.</b> An unknown member is refused rather than ignored, so a client that
/// thinks it set something this build does not understand is told so instead of saving a rule
/// that silently behaves differently.
/// </para>
/// <para>
/// <b>Written canonically.</b> The database trigger that feeds property changes reads
/// <c>trigger ? 'to'</c> and <c>trigger -&gt; 'to' -&gt; 'value'</c> straight out of the stored
/// document, so the stored shape is the one this writer produces and no other.
/// </para>
/// </remarks>
public static class AutomationTriggerJson
{
    /// <summary>The trigger schema this build reads and writes.</summary>
    public const short SchemaVersion = 1;

    /// <summary>The largest offset a date trigger may carry, a week either side.</summary>
    public const int MaximumOffsetMinutes = 10_080;

    private static readonly IDateTimeZoneProvider Zones = DateTimeZoneProviders.Tzdb;

    /// <summary>The storage spelling of a trigger type.</summary>
    public static string TypeText(AutomationTriggerType type) => type switch
    {
        AutomationTriggerType.Schedule => "schedule",
        AutomationTriggerType.DateArrives => "date_arrives",
        AutomationTriggerType.PropertyChanged => "property_changed",
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown trigger type."),
    };

    /// <summary>Reads a trigger document.</summary>
    /// <param name="node">The document, or <see langword="null"/>.</param>
    /// <returns>The trigger, or every reason it was refused.</returns>
    public static AutomationParse<AutomationTrigger> Read(JsonNode? node)
    {
        var violations = new List<AutomationViolation>();
        var trigger = node is JsonObject document
            ? ReadObject(document, violations)
            : Refuse(violations, "trigger", "must be an object");
        return violations.Count == 0
            ? new AutomationParse<AutomationTrigger>(trigger, [])
            : new AutomationParse<AutomationTrigger>(null, [.. violations]);
    }

    /// <summary>Reads a stored trigger that already passed <see cref="Read"/>; throws if it no longer does.</summary>
    public static AutomationTrigger ReadStored(string json)
    {
        var parsed = Read(JsonNode.Parse(json));
        return parsed.Value ?? throw new InvalidOperationException("A stored automation trigger no longer reads.");
    }

    /// <summary>Writes a trigger in its canonical stored shape.</summary>
    public static JsonObject Write(AutomationTrigger trigger)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        var document = new JsonObject { ["type"] = TypeText(trigger.Type) };
        switch (trigger)
        {
            case ScheduleTrigger schedule:
                document["freq"] = schedule.Frequency switch
                {
                    ScheduleFrequency.Daily => "daily",
                    ScheduleFrequency.Weekly => "weekly",
                    _ => "monthly",
                };
                document["interval"] = schedule.Interval;
                if (!schedule.Weekdays.IsDefaultOrEmpty)
                {
                    document["weekdays"] = new JsonArray([.. schedule.Weekdays.Select(day => (JsonNode)JsonValue.Create(WeekdayText(day)))]);
                }

                document["time"] = schedule.Time.ToString("HH:mm", CultureInfo.InvariantCulture);
                if (schedule.TimeZone is not null)
                {
                    document["timeZone"] = schedule.TimeZone;
                }

                if (schedule.StartDate is { } start)
                {
                    document["startDate"] = start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                }

                break;
            case DateArrivesTrigger date:
                document["key"] = date.Key;
                document["offsetMinutes"] = date.OffsetMinutes;
                document["time"] = date.Time.ToString("HH:mm", CultureInfo.InvariantCulture);
                break;
            case PropertyChangedTrigger property:
                document["key"] = property.Key;
                if (property.From is { } from)
                {
                    document["from"] = new JsonObject { ["value"] = from.Value?.DeepClone() };
                }

                if (property.To is { } to)
                {
                    document["to"] = new JsonObject { ["value"] = to.Value?.DeepClone() };
                }

                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(trigger), trigger.Type, "Unknown trigger.");
        }

        return document;
    }

    private static AutomationTrigger? ReadObject(JsonObject document, List<AutomationViolation> violations)
    {
        var type = AutomationJsonRead.String(document, "type", "trigger", violations);
        return type switch
        {
            null => null,
            "schedule" => ReadSchedule(document, violations),
            "date_arrives" => ReadDate(document, violations),
            "property_changed" => ReadProperty(document, violations),
            _ => Refuse(violations, "trigger.type", "is not a known trigger"),
        };
    }

    private static ScheduleTrigger? ReadSchedule(JsonObject document, List<AutomationViolation> violations)
    {
        const string path = "trigger";
        var before = violations.Count;
        AutomationJsonRead.RefuseUnknown(document, path, violations, "type", "freq", "interval", "weekdays", "time", "timeZone", "startDate");

        var frequencyText = AutomationJsonRead.String(document, "freq", path, violations);
        ScheduleFrequency? frequency = frequencyText switch
        {
            null => null,
            "daily" => ScheduleFrequency.Daily,
            "weekly" => ScheduleFrequency.Weekly,
            "monthly" => ScheduleFrequency.Monthly,
            _ => null,
        };
        if (frequencyText is not null && frequency is null)
        {
            violations.Add(new AutomationViolation("trigger.freq", "must be daily, weekly or monthly"));
        }

        var interval = AutomationJsonRead.Integer(document, "interval", path, violations);
        if (interval is < 1 or > RecurrenceRuleJson.MaximumInterval)
        {
            violations.Add(new AutomationViolation("trigger.interval", "must be between 1 and 366"));
        }

        var weekdays = ImmutableArray<IsoDayOfWeek>.Empty;
        if (document.TryGetPropertyValue("weekdays", out var weekdaysNode) && weekdaysNode is not null)
        {
            weekdays = ReadWeekdays(weekdaysNode, violations);
            if (!weekdays.IsEmpty && frequency is not ScheduleFrequency.Weekly)
            {
                violations.Add(new AutomationViolation("trigger.weekdays", "are only allowed on a weekly schedule"));
            }
        }

        var time = ReadTime(document, "time", violations, required: true);
        var zone = AutomationJsonRead.OptionalString(document, "timeZone", path, violations);
        if (zone is not null && Zones.GetZoneOrNull(zone) is null)
        {
            violations.Add(new AutomationViolation("trigger.timeZone", "is not a known IANA time zone"));
        }

        DateOnly? startDate = null;
        var startText = AutomationJsonRead.OptionalString(document, "startDate", path, violations);
        if (startText is not null)
        {
            if (DateOnly.TryParseExact(startText, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
            {
                startDate = parsed;
            }
            else
            {
                violations.Add(new AutomationViolation("trigger.startDate", "must be a yyyy-MM-dd date"));
            }
        }

        return violations.Count > before || frequency is null || interval is null || time is null
            ? null
            : new ScheduleTrigger(frequency.Value, interval.Value, weekdays, time.Value, zone, startDate);
    }

    private static DateArrivesTrigger? ReadDate(JsonObject document, List<AutomationViolation> violations)
    {
        const string path = "trigger";
        var before = violations.Count;
        AutomationJsonRead.RefuseUnknown(document, path, violations, "type", "key", "offsetMinutes", "time");
        var key = AutomationJsonRead.String(document, "key", path, violations);
        AutomationJsonRead.CheckKey(key, "trigger.key", violations);
        var offset = AutomationJsonRead.Integer(document, "offsetMinutes", path, violations, required: false) ?? 0;
        if (offset is < -MaximumOffsetMinutes or > MaximumOffsetMinutes)
        {
            violations.Add(new AutomationViolation("trigger.offsetMinutes", "must be within a week either side"));
        }

        var time = document.ContainsKey("time") ? ReadTime(document, "time", violations, required: true) : new TimeOnly(9, 0);
        return violations.Count > before || key is null || time is null
            ? null
            : new DateArrivesTrigger(key, offset, time.Value);
    }

    private static PropertyChangedTrigger? ReadProperty(JsonObject document, List<AutomationViolation> violations)
    {
        const string path = "trigger";
        var before = violations.Count;
        AutomationJsonRead.RefuseUnknown(document, path, violations, "type", "key", "from", "to");
        var key = AutomationJsonRead.String(document, "key", path, violations);
        AutomationJsonRead.CheckKey(key, "trigger.key", violations);
        var from = ReadMatch(document, "from", violations);
        var to = ReadMatch(document, "to", violations);
        return violations.Count > before || key is null ? null : new PropertyChangedTrigger(key, from, to);
    }

    private static AutomationValueMatch? ReadMatch(JsonObject document, string member, List<AutomationViolation> violations)
    {
        if (!document.TryGetPropertyValue(member, out var raw))
        {
            return null;
        }

        if (raw is not JsonObject match || !match.ContainsKey("value") || match.Count != 1)
        {
            violations.Add(new AutomationViolation($"trigger.{member}", "must be an object with exactly one member, value"));
            return null;
        }

        if (AutomationJsonRead.Bytes(match["value"]) > 1024)
        {
            violations.Add(new AutomationViolation($"trigger.{member}.value", "must be at most 1 KiB"));
            return null;
        }

        return new AutomationValueMatch(match["value"]?.DeepClone());
    }

    private static TimeOnly? ReadTime(JsonObject document, string member, List<AutomationViolation> violations, bool required)
    {
        var text = required
            ? AutomationJsonRead.String(document, member, "trigger", violations)
            : AutomationJsonRead.OptionalString(document, member, "trigger", violations);
        if (text is null)
        {
            return null;
        }

        if (TimeOnly.TryParseExact(text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
        {
            return time;
        }

        violations.Add(new AutomationViolation($"trigger.{member}", "must be an HH:mm time"));
        return null;
    }

    private static ImmutableArray<IsoDayOfWeek> ReadWeekdays(JsonNode node, List<AutomationViolation> violations)
    {
        if (node is not JsonArray array || array.Count > 7)
        {
            violations.Add(new AutomationViolation("trigger.weekdays", "must be a list of up to seven weekdays"));
            return [];
        }

        var days = new SortedSet<IsoDayOfWeek>();
        foreach (var entry in array)
        {
            if (entry is JsonValue value && value.TryGetValue<string>(out var text) && TryWeekday(text, out var day))
            {
                days.Add(day);
            }
            else
            {
                violations.Add(new AutomationViolation("trigger.weekdays", "must name days as mo, tu, we, th, fr, sa or su"));
                return [];
            }
        }

        return [.. days];
    }

    private static bool TryWeekday(string text, out IsoDayOfWeek day)
    {
        day = text switch
        {
            "mo" => IsoDayOfWeek.Monday,
            "tu" => IsoDayOfWeek.Tuesday,
            "we" => IsoDayOfWeek.Wednesday,
            "th" => IsoDayOfWeek.Thursday,
            "fr" => IsoDayOfWeek.Friday,
            "sa" => IsoDayOfWeek.Saturday,
            "su" => IsoDayOfWeek.Sunday,
            _ => 0,
        };
        return day != 0;
    }

    private static string WeekdayText(IsoDayOfWeek day) => day switch
    {
        IsoDayOfWeek.Monday => "mo",
        IsoDayOfWeek.Tuesday => "tu",
        IsoDayOfWeek.Wednesday => "we",
        IsoDayOfWeek.Thursday => "th",
        IsoDayOfWeek.Friday => "fr",
        IsoDayOfWeek.Saturday => "sa",
        _ => "su",
    };

    private static AutomationTrigger? Refuse(List<AutomationViolation> violations, string path, string reason)
    {
        violations.Add(new AutomationViolation(path, reason));
        return null;
    }
}
