using System.Collections.Immutable;
using Nix.Domain.Recurrence;
using Nix.Domain.Scheduling;
using NodaTime;

namespace Nix.Domain.Automations;

/// <summary>One schedule occurrence: the local day it belongs to and the instant it fires.</summary>
public readonly record struct ScheduleOccurrence(DateOnly Day, DateTimeOffset At);

/// <summary>
/// Expands a schedule trigger into occurrences - days from the same recurrence expansion items use,
/// instants resolved leniently in the schedule's zone (or the owner's) so a daylight-saving gap or
/// overlap never throws.
/// </summary>
public static class AutomationSchedule
{
    private static readonly IDateTimeZoneProvider Zones = DateTimeZoneProviders.Tzdb;

    /// <summary>The zone a schedule resolves in: its own, else the owner's.</summary>
    public static string EffectiveZone(ScheduleTrigger trigger, string ownerZone)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        return trigger.TimeZone ?? ownerZone;
    }

    /// <summary>Every occurrence whose instant falls in <c>[from, to)</c>, ascending.</summary>
    /// <param name="trigger">The schedule.</param>
    /// <param name="ownerZone">The owner's zone, used when the schedule names none.</param>
    /// <param name="from">The window start, inclusive.</param>
    /// <param name="to">The window end, exclusive.</param>
    public static IReadOnlyList<ScheduleOccurrence> Occurrences(ScheduleTrigger trigger, string ownerZone, DateTimeOffset from, DateTimeOffset to)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        var zoneId = EffectiveZone(trigger, ownerZone);
        var zone = Zones.GetZoneOrNull(zoneId) ?? throw new ArgumentException($"'{zoneId}' is not a known zone.", nameof(ownerZone));

        // Local days padded by one either side: a zone far from UTC puts the window's instants on
        // local days the UTC calendar does not.
        var firstDay = LocalDay(from, zone).AddDays(-1);
        var lastDay = LocalDay(to, zone).AddDays(1);
        var anchor = trigger.StartDate ?? firstDay;

        var occurrences = new List<ScheduleOccurrence>();
        foreach (var day in RecurrenceExpansion.Occurrences(Rule(trigger), anchor, firstDay, lastDay))
        {
            var at = ReminderQuietHours.ResolveLocalInstant(day, trigger.Time, zoneId);
            if (at >= from && at < to)
            {
                occurrences.Add(new ScheduleOccurrence(day, at));
            }
        }

        return occurrences;
    }

    /// <summary>Whether the schedule still lands on <paramref name="day"/> - its re-verification at fire time.</summary>
    public static bool ProducesDay(ScheduleTrigger trigger, DateOnly day)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        var anchor = trigger.StartDate ?? day;
        return RecurrenceExpansion.Occurrences(Rule(trigger), anchor, day, day).Any();
    }

    /// <summary>The local date an instant falls on in a zone.</summary>
    public static DateOnly LocalDate(DateTimeOffset instant, string zoneId)
    {
        var zone = Zones.GetZoneOrNull(zoneId) ?? DateTimeZone.Utc;
        return LocalDay(instant, zone);
    }

    private static DateOnly LocalDay(DateTimeOffset instant, DateTimeZone zone)
    {
        var local = Instant.FromDateTimeOffset(instant).InZone(zone);
        return new DateOnly(local.Year, local.Month, local.Day);
    }

    private static RecurrenceRule Rule(ScheduleTrigger trigger) => new(
        trigger.Frequency switch
        {
            ScheduleFrequency.Daily => RecurrenceFrequency.Daily,
            ScheduleFrequency.Weekly => RecurrenceFrequency.Weekly,
            _ => RecurrenceFrequency.Monthly,
        },
        trigger.Interval,
        trigger.Weekdays.IsDefault ? [] : trigger.Weekdays,
        null,
        null,
        ImmutableArray<DateOnly>.Empty);
}
