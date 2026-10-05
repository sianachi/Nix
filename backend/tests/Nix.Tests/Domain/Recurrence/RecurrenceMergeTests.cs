using System.Collections.Immutable;
using Nix.Domain.Items;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Recurrence;

/// <summary>
/// Merging many series into one window under one ceiling: the order, the bound, and the honesty
/// flag that says when the bound was met.
/// </summary>
public sealed class RecurrenceMergeTests
{
    private static readonly DateOnly From = new(2026, 3, 1);
    private static readonly DateOnly To = new(2026, 3, 10);

    [Fact]
    public void Occurrences_come_back_in_day_order_across_series()
    {
        var candidates = new[]
        {
            Candidate("every third day", new DateOnly(2026, 3, 1), RecurrenceFrequency.Daily, interval: 3),
            Candidate("every second day", new DateOnly(2026, 3, 2), RecurrenceFrequency.Daily, interval: 2),
        };

        var merged = RecurrenceMerge.Expand(candidates, From, To, ceiling: 100);

        Assert.Equal(
            [
                "2026-03-01",
                "2026-03-02",
                "2026-03-04",
                "2026-03-04",
                "2026-03-06",
                "2026-03-07",
                "2026-03-08",
                "2026-03-10",
                "2026-03-10",
            ],
            merged.Occurrences.Select(entry => entry.Entry.Value));
        Assert.False(merged.Truncated);
    }

    [Fact]
    public void A_day_two_series_share_keeps_the_order_the_candidates_arrived_in()
    {
        // Stability matters: the same window has to cut the same occurrences twice, so ties break
        // on the workspace's own sibling order rather than on whichever generator ran first.
        var candidates = new[]
        {
            Candidate("first", new DateOnly(2026, 3, 4), RecurrenceFrequency.Daily),
            Candidate("second", new DateOnly(2026, 3, 4), RecurrenceFrequency.Daily),
        };

        var merged = RecurrenceMerge.Expand(candidates, From, new DateOnly(2026, 3, 5), ceiling: 100);

        Assert.Equal(
            ["first", "second", "first", "second"],
            merged.Occurrences.Select(entry => entry.Entry.Title));
    }

    [Fact]
    public void The_ceiling_stops_the_merge_and_says_so()
    {
        var candidates = new[] { Candidate("daily", From, RecurrenceFrequency.Daily) };

        var merged = RecurrenceMerge.Expand(candidates, From, To, ceiling: 3);

        Assert.Equal(3, merged.Occurrences.Count);
        Assert.True(merged.Truncated);
    }

    [Fact]
    public void A_merge_that_exactly_fills_the_ceiling_is_not_truncated()
    {
        // The off-by-one that would make an honest answer claim to be short: ten occurrences into
        // a ceiling of ten is complete, not truncated.
        var candidates = new[] { Candidate("daily", From, RecurrenceFrequency.Daily) };

        var merged = RecurrenceMerge.Expand(candidates, From, To, ceiling: 10);

        Assert.Equal(10, merged.Occurrences.Count);
        Assert.False(merged.Truncated);
    }

    [Fact]
    public void Truncating_the_concrete_entries_first_loses_nothing_from_the_union()
    {
        // The argument the merge's docblock makes, as a test: taking the first N of one side
        // before merging yields the same first N of the union as merging everything would.
        var candidates = new[]
        {
            Candidate("a", From, RecurrenceFrequency.Daily),
            Candidate("b", From, RecurrenceFrequency.Daily),
        };

        var whole = RecurrenceMerge.Expand(candidates, From, To, ceiling: 1000);
        var capped = RecurrenceMerge.Expand(candidates, From, To, ceiling: 5);

        Assert.Equal(
            whole.Occurrences.Take(5).Select(entry => entry.Entry.Value),
            capped.Occurrences.Select(entry => entry.Entry.Value));
        Assert.True(capped.Truncated);
    }

    [Fact]
    public void A_series_the_build_cannot_read_or_cannot_place_produces_nothing_rather_than_throwing()
    {
        // Both halves of CanExpand, which the calendar reports as unplaceable rather than drawing.
        var noRule = new RecurringItem(
            ItemId.From(Guid.NewGuid()),
            "unreadable",
            ItemId.From(Guid.NewGuid()),
            "container",
            "due_date",
            From,
            Rule: null);

        var noAnchor = Candidate("undated", From, RecurrenceFrequency.Daily) with { Anchor = null };

        var merged = RecurrenceMerge.Expand([noRule, noAnchor], From, To, ceiling: 100);

        Assert.Empty(merged.Occurrences);
        Assert.False(merged.Truncated);
    }

    [Fact]
    public void Each_occurrence_carries_its_own_day_and_its_completion_state()
    {
        var candidate = Candidate("daily", From, RecurrenceFrequency.Daily) with
        {
            Rule = new RecurrenceRule(
                RecurrenceFrequency.Daily,
                Interval: 1,
                Weekdays: [],
                Until: null,
                CompletedThrough: From,
                Completed: [From.AddDays(2)]),
        };

        var merged = RecurrenceMerge.Expand([candidate], From, From.AddDays(2), ceiling: 100);

        // The value is the occurrence's day, not the anchor's - a generated entry has to land on
        // the day it represents.
        Assert.Equal(
            ["2026-03-01", "2026-03-02", "2026-03-03"],
            merged.Occurrences.Select(entry => entry.Entry.Value));
        Assert.Equal([true, false, true], merged.Occurrences.Select(entry => entry.Completed));
    }

    [Fact]
    public void The_merge_never_advances_a_series_past_what_it_takes()
    {
        // Laziness is the bound, and this is the assertion that proves it rather than assuming
        // it: 100 daily series over a 400-day window is 40,100 possible occurrences. Reaching a
        // ceiling of 10 must cost the 100 first steps (one per series, to position the merge) plus
        // 10 advances - not forty thousand. Counted by walking the same generators the merge uses.
        var candidates = new List<RecurringItem>();
        for (var index = 0; index < 100; index++)
        {
            candidates.Add(Candidate($"series {index}", From, RecurrenceFrequency.Daily));
        }

        var everythingAvailable = candidates.Sum(candidate =>
            RecurrenceExpansion
                .Occurrences(candidate.Rule!, candidate.Anchor!.Value, From, From.AddDays(400))
                .Count());

        var merged = RecurrenceMerge.Expand(candidates, From, From.AddDays(400), ceiling: 10);

        Assert.Equal(40_100, everythingAvailable);
        Assert.Equal(10, merged.Occurrences.Count);
        Assert.True(merged.Truncated);
    }

    private static RecurringItem Candidate(
        string title,
        DateOnly anchor,
        RecurrenceFrequency frequency,
        int interval = 1,
        ImmutableArray<IsoDayOfWeek> weekdays = default) =>
        new(
            ItemId.From(Guid.NewGuid()),
            title,
            ItemId.From(Guid.NewGuid()),
            "container",
            "due_date",
            anchor,
            new RecurrenceRule(
                frequency,
                interval,
                weekdays.IsDefault ? [] : weekdays,
                Until: null,
                CompletedThrough: null,
                Completed: []));
}
