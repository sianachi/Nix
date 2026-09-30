using System.Collections.Immutable;
using Nix.Domain.Automations;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Automations;

/// <summary>
/// Schedule occurrences: days from the recurrence expansion, instants resolved leniently in the
/// schedule's zone so a daylight-saving gap or overlap never throws.
/// </summary>
public sealed class AutomationScheduleTests
{
    private static ScheduleTrigger Daily(TimeOnly time, DateOnly start, string? zone = null) =>
        new(ScheduleFrequency.Daily, 1, [], time, zone, start);

    [Fact]
    public void A_daily_schedule_yields_one_instant_per_day_in_the_window()
    {
        var trigger = Daily(new TimeOnly(9, 0), new DateOnly(2026, 10, 1));
        var from = new DateTimeOffset(2026, 10, 5, 0, 0, 0, TimeSpan.Zero);

        var occurrences = AutomationSchedule.Occurrences(trigger, "Etc/UTC", from, from.AddHours(48));

        Assert.Equal(
            [new DateTimeOffset(2026, 10, 5, 9, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 6, 9, 0, 0, TimeSpan.Zero)],
            occurrences.Select(occurrence => occurrence.At).ToArray());
        Assert.Equal(new DateOnly(2026, 10, 5), occurrences[0].Day);
    }

    [Fact]
    public void Nothing_occurs_before_the_start_date()
    {
        var trigger = Daily(new TimeOnly(9, 0), new DateOnly(2026, 10, 6));
        var from = new DateTimeOffset(2026, 10, 5, 0, 0, 0, TimeSpan.Zero);

        var occurrences = AutomationSchedule.Occurrences(trigger, "Etc/UTC", from, from.AddHours(48));

        Assert.Equal(new DateOnly(2026, 10, 6), Assert.Single(occurrences).Day);
    }

    [Fact]
    public void A_weekly_schedule_lands_only_on_its_weekdays()
    {
        var trigger = new ScheduleTrigger(
            ScheduleFrequency.Weekly, 1, ImmutableArray.Create(IsoDayOfWeek.Tuesday), new TimeOnly(8, 0), null, new DateOnly(2026, 10, 5));

        Assert.True(AutomationSchedule.ProducesDay(trigger, new DateOnly(2026, 10, 6)));
        Assert.False(AutomationSchedule.ProducesDay(trigger, new DateOnly(2026, 10, 7)));
    }

    [Fact]
    public void A_monthly_schedule_from_the_31st_clamps_to_the_month_end()
    {
        var trigger = new ScheduleTrigger(ScheduleFrequency.Monthly, 1, [], new TimeOnly(8, 0), null, new DateOnly(2026, 1, 31));

        Assert.True(AutomationSchedule.ProducesDay(trigger, new DateOnly(2026, 2, 28)));
        Assert.False(AutomationSchedule.ProducesDay(trigger, new DateOnly(2026, 2, 27)));
    }

    [Fact]
    public void A_time_in_the_London_spring_gap_is_shifted_forward_by_the_gap()
    {
        // 2027-03-28 01:30 does not exist in Europe/London: clocks jump from 01:00 GMT to 02:00 BST.
        // NodaTime's lenient resolver shifts it forward by the gap's length, to 02:30 BST.
        var trigger = Daily(new TimeOnly(1, 30), new DateOnly(2027, 3, 1), "Europe/London");
        var from = new DateTimeOffset(2027, 3, 28, 0, 0, 0, TimeSpan.Zero);

        var occurrence = AutomationSchedule.Occurrences(trigger, "Etc/UTC", from, from.AddHours(12)).Single();

        Assert.Equal(new DateOnly(2027, 3, 28), occurrence.Day);
        Assert.Equal(new DateTimeOffset(2027, 3, 28, 1, 30, 0, TimeSpan.Zero), occurrence.At);
    }

    [Fact]
    public void A_time_in_the_London_autumn_overlap_resolves_to_the_earlier_instant()
    {
        // 2026-10-25 01:30 happens twice in Europe/London; the first is 00:30 UTC (BST).
        var trigger = Daily(new TimeOnly(1, 30), new DateOnly(2026, 10, 1), "Europe/London");
        var from = new DateTimeOffset(2026, 10, 25, 0, 0, 0, TimeSpan.Zero);

        var occurrence = AutomationSchedule.Occurrences(trigger, "Etc/UTC", from, from.AddHours(12)).Single();

        Assert.Equal(new DateTimeOffset(2026, 10, 25, 0, 30, 0, TimeSpan.Zero), occurrence.At);
    }

    [Fact]
    public void The_schedule_zone_wins_over_the_owner_zone()
    {
        var trigger = Daily(new TimeOnly(9, 0), new DateOnly(2026, 10, 1), "America/New_York");
        var from = new DateTimeOffset(2026, 10, 5, 0, 0, 0, TimeSpan.Zero);

        var occurrence = AutomationSchedule.Occurrences(trigger, "Asia/Tokyo", from, from.AddHours(24)).Single();

        Assert.Equal(new DateTimeOffset(2026, 10, 5, 13, 0, 0, TimeSpan.Zero), occurrence.At);
    }
}
