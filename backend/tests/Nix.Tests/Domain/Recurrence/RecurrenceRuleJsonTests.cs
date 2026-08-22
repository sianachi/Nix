using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Recurrence;

/// <summary>
/// The stored shape of a rule, and the fail-closed reading that keeps a rule this build cannot
/// interpret from becoming a series it invented.
/// </summary>
public sealed class RecurrenceRuleJsonTests
{
    [Fact]
    public void Every_field_survives_a_round_trip()
    {
        var rule = new RecurrenceRule(
            RecurrenceFrequency.Weekly,
            Interval: 2,
            Weekdays: [IsoDayOfWeek.Monday, IsoDayOfWeek.Thursday],
            Until: new DateOnly(2026, 12, 31),
            CompletedThrough: new DateOnly(2026, 3, 2),
            Completed: [new DateOnly(2026, 3, 12), new DateOnly(2026, 3, 19)]);

        var read = RecurrenceRuleJson.Read(RecurrenceRuleJson.Write(rule));

        Assert.Equal(rule, read);
    }

    [Fact]
    public void A_minimal_rule_writes_only_what_it_carries()
    {
        var json = RecurrenceRuleJson.Write(Rule(RecurrenceFrequency.Daily));
        var document = JsonNode.Parse(json)?.AsObject();

        // Absent rather than null: a rule with no end and no completions should not store four
        // keys saying so, because the size bound is what keeps a long-lived series storable.
        Assert.NotNull(document);
        Assert.Equal(["freq", "interval"], document!.Select(pair => pair.Key).ToArray());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Nothing_stored_is_no_rule_rather_than_a_failure(string? json) =>
        Assert.Null(RecurrenceRuleJson.Read(json));

    [Theory]
    [InlineData("not json at all")]
    [InlineData("[]")]
    [InlineData("""{"interval":1}""")]
    [InlineData("""{"freq":"fortnightly","interval":1}""")]
    [InlineData("""{"freq":"daily"}""")]
    [InlineData("""{"freq":"daily","interval":0}""")]
    [InlineData("""{"freq":"daily","interval":-1}""")]
    [InlineData("""{"freq":"daily","interval":367}""")]
    [InlineData("""{"freq":"daily","interval":"1"}""")]
    public void A_rule_this_build_cannot_interpret_is_dropped_rather_than_guessed_at(string json) =>
        Assert.Null(RecurrenceRuleJson.Read(json));

    [Fact]
    public void Weekdays_on_a_rule_that_is_not_weekly_are_refused_rather_than_ignored()
    {
        // Ignoring an input somebody typed is a lie about what the series will do.
        Assert.Null(RecurrenceRuleJson.Read("""{"freq":"monthly","interval":1,"weekdays":["mo"]}"""));
    }

    [Theory]
    [InlineData("""{"freq":"weekly","interval":1,"weekdays":[]}""")]
    [InlineData("""{"freq":"weekly","interval":1,"weekdays":["mo","mo"]}""")]
    [InlineData("""{"freq":"weekly","interval":1,"weekdays":["monday"]}""")]
    [InlineData("""{"freq":"weekly","interval":1,"weekdays":"mo"}""")]
    public void A_weekday_list_that_says_nothing_usable_is_refused(string json) =>
        Assert.Null(RecurrenceRuleJson.Read(json));

    [Theory]
    [InlineData("""{"freq":"daily","interval":1,"until":"31/12/2026"}""")]
    [InlineData("""{"freq":"daily","interval":1,"until":"2026-12-31T00:00:00Z"}""")]
    [InlineData("""{"freq":"daily","interval":1,"completedThrough":"soon"}""")]
    [InlineData("""{"freq":"daily","interval":1,"completed":["2026-13-01"]}""")]
    [InlineData("""{"freq":"daily","interval":1,"completed":"2026-03-02"}""")]
    public void A_malformed_day_anywhere_refuses_the_whole_rule(string json) =>
        Assert.Null(RecurrenceRuleJson.Read(json));

    [Fact]
    public void An_unsorted_completion_list_is_refused()
    {
        Assert.Null(RecurrenceRuleJson.Read(
            """{"freq":"daily","interval":1,"completed":["2026-03-05","2026-03-02"]}"""));
    }

    [Fact]
    public void A_completion_at_or_below_the_watermark_is_refused_as_a_contradiction()
    {
        // The two halves of the completion state must not disagree: below the watermark is
        // already complete, so listing it again means one of the two is wrong.
        Assert.Null(RecurrenceRuleJson.Read(
            """{"freq":"daily","interval":1,"completedThrough":"2026-03-05","completed":["2026-03-05"]}"""));
    }

    [Fact]
    public void More_completions_than_the_bound_allows_are_refused()
    {
        var days = Enumerable
            .Range(0, RecurrenceRuleJson.MaximumCompleted + 1)
            .Select(offset => $"\"{new DateOnly(2026, 1, 1).AddDays(offset):yyyy-MM-dd}\"");

        var json = $$"""{"freq":"daily","interval":1,"completed":[{{string.Join(',', days)}}]}""";

        Assert.Null(RecurrenceRuleJson.Read(json));
    }

    [Fact]
    public void A_rule_at_the_completion_bound_still_fits_the_size_bound()
    {
        // The three bounds have to agree, or the guard refuses what the CHECK would have taken -
        // or worse, the reverse.
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            Completed =
            [
                .. Enumerable
                    .Range(0, RecurrenceRuleJson.MaximumCompleted)
                    .Select(offset => new DateOnly(2026, 1, 1).AddDays(offset * 2)),
            ],
        };

        var json = RecurrenceRuleJson.Write(rule);

        Assert.True(RecurrenceRuleJson.IsWithinBounds(json));
        Assert.Equal(rule, RecurrenceRuleJson.Read(json));
    }

    [Fact]
    public void Compaction_folds_contiguous_completions_into_the_watermark()
    {
        var anchor = new DateOnly(2026, 3, 2);
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            Completed = [anchor, anchor.AddDays(1), anchor.AddDays(2), anchor.AddDays(9)],
        };

        var compacted = RecurrenceRuleJson.Compact(rule, anchor);

        // Three in a row become the watermark; the straggler stays an exception.
        Assert.Equal(anchor.AddDays(2), compacted.CompletedThrough);
        Assert.Equal([anchor.AddDays(9)], compacted.Completed);
    }

    [Fact]
    public void Compaction_advances_an_existing_watermark_without_an_off_by_one()
    {
        var anchor = new DateOnly(2026, 3, 2);
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            CompletedThrough = anchor.AddDays(4),
            Completed = [anchor.AddDays(5), anchor.AddDays(6)],
        };

        var compacted = RecurrenceRuleJson.Compact(rule, anchor);

        Assert.Equal(anchor.AddDays(6), compacted.CompletedThrough);
        Assert.Empty(compacted.Completed);
    }

    [Fact]
    public void Compaction_leaves_a_gap_alone()
    {
        var anchor = new DateOnly(2026, 3, 2);
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            Completed = [anchor.AddDays(3), anchor.AddDays(4)],
        };

        var compacted = RecurrenceRuleJson.Compact(rule, anchor);

        // The anchor itself is not complete, so nothing folds - the watermark would claim it.
        Assert.Null(compacted.CompletedThrough);
        Assert.Equal([anchor.AddDays(3), anchor.AddDays(4)], compacted.Completed);
    }

    [Fact]
    public void Compaction_of_a_weekly_series_follows_the_series_not_the_calendar()
    {
        // Contiguity means "the next occurrence", never "the next day": a weekly series whose
        // last four occurrences are done must fold all four.
        var anchor = new DateOnly(2026, 3, 2);
        var rule = Rule(RecurrenceFrequency.Weekly) with
        {
            Completed = [anchor, anchor.AddDays(7), anchor.AddDays(14)],
        };

        var compacted = RecurrenceRuleJson.Compact(rule, anchor);

        Assert.Equal(anchor.AddDays(14), compacted.CompletedThrough);
        Assert.Empty(compacted.Completed);
    }

    private static RecurrenceRule Rule(
        RecurrenceFrequency frequency,
        int interval = 1,
        ImmutableArray<IsoDayOfWeek> weekdays = default) =>
        new(
            frequency,
            interval,
            weekdays.IsDefault ? [] : weekdays,
            Until: null,
            CompletedThrough: null,
            Completed: []);
}
