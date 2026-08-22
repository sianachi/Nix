using System.Collections.Immutable;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Recurrence;

/// <summary>
/// The occurrence arithmetic, which is where every recurrence bug anybody has ever shipped lives:
/// month ends, leap days, windows that open before the series starts, and series that outlive the
/// window.
/// </summary>
public sealed class RecurrenceExpansionTests
{
    private static readonly DateOnly Anchor = new(2026, 3, 2);

    [Fact]
    public void A_daily_rule_yields_every_day_from_the_anchor()
    {
        var days = Expand(Rule(RecurrenceFrequency.Daily), Anchor, Anchor, Anchor.AddDays(4));

        Assert.Equal(
            [Anchor, Anchor.AddDays(1), Anchor.AddDays(2), Anchor.AddDays(3), Anchor.AddDays(4)],
            days);
    }

    [Fact]
    public void An_interval_skips_the_units_between()
    {
        var days = Expand(Rule(RecurrenceFrequency.Daily, interval: 3), Anchor, Anchor, Anchor.AddDays(7));

        Assert.Equal([Anchor, Anchor.AddDays(3), Anchor.AddDays(6)], days);
    }

    [Fact]
    public void A_weekly_rule_lands_on_the_anchor_s_own_weekday()
    {
        var days = Expand(Rule(RecurrenceFrequency.Weekly), Anchor, Anchor, Anchor.AddDays(21));

        Assert.Equal(
            [Anchor, Anchor.AddDays(7), Anchor.AddDays(14), Anchor.AddDays(21)],
            days);
        Assert.All(days, day => Assert.Equal(Anchor.DayOfWeek, day.DayOfWeek));
    }

    [Fact]
    public void Named_weekdays_land_on_each_of_them_inside_every_week()
    {
        // Anchored on a Monday; Wednesday and Friday of the same week are occurrences too.
        var rule = Rule(
            RecurrenceFrequency.Weekly,
            weekdays: [IsoDayOfWeek.Monday, IsoDayOfWeek.Wednesday, IsoDayOfWeek.Friday]);

        var days = Expand(rule, Anchor, Anchor, Anchor.AddDays(9));

        Assert.Equal(
            [Anchor, Anchor.AddDays(2), Anchor.AddDays(4), Anchor.AddDays(7), Anchor.AddDays(9)],
            days);
    }

    [Fact]
    public void Named_weekdays_with_an_interval_skip_whole_weeks_not_days()
    {
        var rule = Rule(
            RecurrenceFrequency.Weekly,
            interval: 2,
            weekdays: [IsoDayOfWeek.Monday, IsoDayOfWeek.Wednesday]);

        var days = Expand(rule, Anchor, Anchor, Anchor.AddDays(20));

        // This week's Monday and Wednesday, then a week skipped, then the next pair.
        Assert.Equal(
            [Anchor, Anchor.AddDays(2), Anchor.AddDays(14), Anchor.AddDays(16)],
            days);
    }

    [Fact]
    public void A_monthly_rule_clamps_to_the_month_end_rather_than_skipping_the_month()
    {
        // The 31st: February has no such day, and a series that silently missed February would
        // read as a bug to every person who set it.
        var anchor = new DateOnly(2026, 1, 31);
        var days = Expand(Rule(RecurrenceFrequency.Monthly), anchor, anchor, new DateOnly(2026, 5, 1));

        Assert.Equal(
            [
                new DateOnly(2026, 1, 31),
                new DateOnly(2026, 2, 28),
                new DateOnly(2026, 3, 31),
                new DateOnly(2026, 4, 30),
            ],
            days);
    }

    [Fact]
    public void A_monthly_clamp_is_not_sticky_the_anchor_day_returns_when_the_month_has_it()
    {
        // Clamping February must not drag March to the 28th: the anchor is the source of truth,
        // never the previous occurrence.
        var anchor = new DateOnly(2026, 1, 30);
        var days = Expand(Rule(RecurrenceFrequency.Monthly), anchor, anchor, new DateOnly(2026, 3, 31));

        Assert.Equal(
            [new DateOnly(2026, 1, 30), new DateOnly(2026, 2, 28), new DateOnly(2026, 3, 30)],
            days);
    }

    [Fact]
    public void A_monthly_clamp_takes_the_leap_day_when_the_year_has_one()
    {
        var anchor = new DateOnly(2028, 1, 31);
        var days = Expand(Rule(RecurrenceFrequency.Monthly), anchor, anchor, new DateOnly(2028, 3, 1));

        Assert.Equal([new DateOnly(2028, 1, 31), new DateOnly(2028, 2, 29)], days);
    }

    [Fact]
    public void A_yearly_rule_clamps_the_leap_day_to_the_28th_off_leap_years()
    {
        var anchor = new DateOnly(2028, 2, 29);
        var days = Expand(Rule(RecurrenceFrequency.Yearly), anchor, anchor, new DateOnly(2032, 3, 1));

        Assert.Equal(
            [
                new DateOnly(2028, 2, 29),
                new DateOnly(2029, 2, 28),
                new DateOnly(2030, 2, 28),
                new DateOnly(2031, 2, 28),
                new DateOnly(2032, 2, 29),
            ],
            days);
    }

    [Fact]
    public void Until_is_inclusive_on_its_own_day()
    {
        var rule = Rule(RecurrenceFrequency.Daily, until: Anchor.AddDays(2));
        var days = Expand(rule, Anchor, Anchor, Anchor.AddDays(10));

        Assert.Equal([Anchor, Anchor.AddDays(1), Anchor.AddDays(2)], days);
    }

    [Fact]
    public void A_window_opening_after_the_anchor_still_sees_the_series()
    {
        // The trap: a series anchored a year ago must expand into today's window. Pruning by the
        // window's start would drop every long-running series, which is the whole feature.
        var anchor = new DateOnly(2025, 1, 1);
        var days = Expand(
            Rule(RecurrenceFrequency.Monthly),
            anchor,
            new DateOnly(2026, 3, 1),
            new DateOnly(2026, 5, 2));

        Assert.Equal(
            [new DateOnly(2026, 3, 1), new DateOnly(2026, 4, 1), new DateOnly(2026, 5, 1)],
            days);
    }

    [Fact]
    public void A_window_ending_before_the_anchor_sees_nothing()
    {
        var days = Expand(
            Rule(RecurrenceFrequency.Daily),
            Anchor,
            Anchor.AddDays(-10),
            Anchor.AddDays(-1));

        Assert.Empty(days);
    }

    [Fact]
    public void A_window_opening_before_the_anchor_starts_at_the_anchor()
    {
        var days = Expand(
            Rule(RecurrenceFrequency.Daily),
            Anchor,
            Anchor.AddDays(-5),
            Anchor.AddDays(1));

        Assert.Equal([Anchor, Anchor.AddDays(1)], days);
    }

    [Fact]
    public void The_generator_advances_only_as_far_as_it_is_read()
    {
        // Laziness is load-bearing: the calendar merges up to 500 series under one 2,000-entry
        // ceiling, and an eager generator would compute 400 days per series for a merge that may
        // take three from it.
        var taken = RecurrenceExpansion
            .Occurrences(Rule(RecurrenceFrequency.Daily), Anchor, Anchor, Anchor.AddDays(400))
            .Take(5)
            .ToList();

        Assert.Equal(5, taken.Count);
        Assert.Equal(Anchor.AddDays(4), taken[^1]);
    }

    [Fact]
    public void Completion_state_does_not_change_which_days_occur()
    {
        // A completed occurrence is still an occurrence - it is drawn as done, not withheld.
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            CompletedThrough = Anchor.AddDays(1),
            Completed = [Anchor.AddDays(3)],
        };

        var days = Expand(rule, Anchor, Anchor, Anchor.AddDays(3));

        Assert.Equal([Anchor, Anchor.AddDays(1), Anchor.AddDays(2), Anchor.AddDays(3)], days);
        Assert.True(rule.IsCompleted(Anchor));
        Assert.True(rule.IsCompleted(Anchor.AddDays(1)));
        Assert.False(rule.IsCompleted(Anchor.AddDays(2)));
        Assert.True(rule.IsCompleted(Anchor.AddDays(3)));
    }

    private static List<DateOnly> Expand(
        RecurrenceRule rule,
        DateOnly anchor,
        DateOnly from,
        DateOnly to) =>
        [.. RecurrenceExpansion.Occurrences(rule, anchor, from, to)];

    private static RecurrenceRule Rule(
        RecurrenceFrequency frequency,
        int interval = 1,
        ImmutableArray<IsoDayOfWeek> weekdays = default,
        DateOnly? until = null) =>
        new(
            frequency,
            interval,
            weekdays.IsDefault ? [] : weekdays,
            until,
            CompletedThrough: null,
            Completed: []);
}
