using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Recurrence;

namespace Nix.Domain.Automations;

/// <summary>What starts an automation rule (ADR-0051 section 6).</summary>
public enum AutomationTriggerType
{
    /// <summary>A clock schedule: daily, weekly or monthly at a local time.</summary>
    Schedule,

    /// <summary>A date property on an item in scope arriving, offset by minutes.</summary>
    DateArrives,

    /// <summary>A property on an item in scope changing.</summary>
    PropertyChanged,
}

/// <summary>How often a schedule trigger repeats.</summary>
public enum ScheduleFrequency
{
    /// <summary>Every <c>Interval</c> days.</summary>
    Daily,

    /// <summary>Every <c>Interval</c> weeks, optionally on named weekdays.</summary>
    Weekly,

    /// <summary>Every <c>Interval</c> months, clamped to the month's last day.</summary>
    Monthly,
}

/// <summary>A rule's trigger, read from its stored, versioned JSON.</summary>
public abstract record AutomationTrigger
{
    /// <summary>Gets which kind of trigger this is.</summary>
    public abstract AutomationTriggerType Type { get; }
}

/// <summary>Fires on a clock schedule, in the schedule's own zone or the owner's.</summary>
/// <param name="Frequency">Daily, weekly or monthly.</param>
/// <param name="Interval">Every how many units, 1..366.</param>
/// <param name="Weekdays">Weekly only: which days; empty means the start date's weekday.</param>
/// <param name="Time">The local time of day it fires.</param>
/// <param name="TimeZone">An IANA zone, or <see langword="null"/> to follow the owner's preferences.</param>
/// <param name="StartDate">
/// The first local day it may fire and the anchor intervals count from. The API fills it with the
/// creation day when a caller leaves it out, so a stored rule always has one.
/// </param>
public sealed record ScheduleTrigger(
    ScheduleFrequency Frequency,
    int Interval,
    ImmutableArray<IsoDayOfWeek> Weekdays,
    TimeOnly Time,
    string? TimeZone,
    DateOnly? StartDate) : AutomationTrigger
{
    /// <inheritdoc />
    public override AutomationTriggerType Type => AutomationTriggerType.Schedule;
}

/// <summary>Fires when a date property on an item in scope arrives, shifted by an offset.</summary>
/// <param name="Key">The property whose value names the day or instant to fire at.</param>
/// <param name="OffsetMinutes">Minutes after (positive) or before (negative) the date, -10080..10080.</param>
/// <param name="Time">The local time a date-only value fires at, in the owner's zone.</param>
public sealed record DateArrivesTrigger(string Key, int OffsetMinutes, TimeOnly Time) : AutomationTrigger
{
    /// <inheritdoc />
    public override AutomationTriggerType Type => AutomationTriggerType.DateArrives;
}

/// <summary>A value a property-change trigger compares against; <see cref="Value"/> null means the property was cleared.</summary>
/// <param name="Value">The JSON value, or <see langword="null"/> for "no value".</param>
public sealed record AutomationValueMatch(JsonNode? Value);

/// <summary>Fires when a property on an item in scope changes.</summary>
/// <param name="Key">The watched property.</param>
/// <param name="From">The value it must change from, or <see langword="null"/> for any.</param>
/// <param name="To">The value it must change to, or <see langword="null"/> for any change.</param>
public sealed record PropertyChangedTrigger(string Key, AutomationValueMatch? From, AutomationValueMatch? To) : AutomationTrigger
{
    /// <inheritdoc />
    public override AutomationTriggerType Type => AutomationTriggerType.PropertyChanged;
}
