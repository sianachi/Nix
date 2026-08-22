using System.Collections.Immutable;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Recurrence;

/// <summary>
/// The guard every recurrence write crosses: what it accepts, what it refuses with a mapped code,
/// and the one case it treats as success precisely because nothing changed.
/// </summary>
/// <remarks>
/// The bounds here are the reason the column's CHECK constraint never fires in practice. A test
/// that only proved the happy path would leave the guard's whole purpose - turning a constraint
/// violation into a sentence somebody can act on - unexercised.
/// </remarks>
public sealed class RecurrenceWritesTests
{
    private static readonly DateOnly Anchor = new(2026, 3, 2);

    [Fact]
    public void A_rule_that_fits_is_written_as_the_json_its_reader_accepts()
    {
        var rule = Rule(RecurrenceFrequency.Weekly, interval: 2);

        var prepared = RecurrenceWrites.PrepareRule(rule);

        Assert.True(prepared.IsSuccess);
        // The round trip is the invariant: what the guard emits, the reader must take back.
        Assert.Equal(rule, RecurrenceRuleJson.Read(prepared.Value));
    }

    [Fact]
    public void A_rule_too_large_to_store_is_refused_with_a_code_rather_than_left_to_the_database()
    {
        // Reachable only by handing the guard a rule assembled outside it - which is exactly the
        // path the CHECK constraint exists to catch, and exactly the one this refusal replaces.
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            Completed =
            [
                .. Enumerable
                    .Range(0, 400)
                    .Select(offset => new DateOnly(2026, 1, 1).AddDays(offset * 2)),
            ],
        };

        var prepared = RecurrenceWrites.PrepareRule(rule);

        Assert.True(prepared.IsFailure);
        Assert.Equal("recurrence.rule_too_large", prepared.Error.Code);
    }

    [Fact]
    public void Completing_an_occurrence_adds_it_and_leaves_the_series_alone()
    {
        var rule = Rule(RecurrenceFrequency.Daily);

        var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(3));

        Assert.True(applied.IsSuccess);
        Assert.Equal(RecurrenceCompletionOutcome.Prepared, applied.Value.Outcome);

        var stored = RecurrenceRuleJson.Read(applied.Value.RuleJson);
        Assert.NotNull(stored);
        // The rule itself is untouched - completing one instance must not shorten, shift or
        // end the series.
        Assert.Equal(rule.Frequency, stored!.Frequency);
        Assert.Equal(rule.Interval, stored.Interval);
        Assert.Equal(rule.Until, stored.Until);
        Assert.True(stored.IsCompleted(Anchor.AddDays(3)));
        Assert.False(stored.IsCompleted(Anchor.AddDays(4)));
    }

    [Fact]
    public void Completing_the_same_occurrence_twice_is_success_with_nothing_to_store()
    {
        // Idempotent by contract: a retried request, or two clients pressing the same tick, must
        // not be an error - and must not produce a write either.
        var rule = Rule(RecurrenceFrequency.Daily) with { Completed = [Anchor.AddDays(3)] };

        var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(3));

        Assert.True(applied.IsSuccess);
        Assert.Equal(RecurrenceCompletionOutcome.AlreadyComplete, applied.Value.Outcome);
        Assert.Null(applied.Value.RuleJson);
    }

    [Fact]
    public void An_occurrence_at_or_below_the_watermark_is_already_complete()
    {
        var rule = Rule(RecurrenceFrequency.Daily) with { CompletedThrough = Anchor.AddDays(5) };

        var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(2));

        Assert.True(applied.IsSuccess);
        Assert.Equal(RecurrenceCompletionOutcome.AlreadyComplete, applied.Value.Outcome);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    public void A_day_the_series_does_not_land_on_is_refused(int offset)
    {
        // Every second day from the anchor: the odd days between are not occurrences, and ticking
        // one would record a completion for something that never happens.
        var rule = Rule(RecurrenceFrequency.Daily, interval: 2);

        var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(offset));

        Assert.True(applied.IsFailure);
        Assert.Equal("recurrence.not_an_occurrence", applied.Error.Code);
    }

    [Fact]
    public void A_day_before_the_series_begins_is_refused()
    {
        var applied = RecurrenceWrites.ApplyCompletion(
            Rule(RecurrenceFrequency.Daily),
            Anchor,
            Anchor.AddDays(-1));

        Assert.True(applied.IsFailure);
        Assert.Equal("recurrence.not_an_occurrence", applied.Error.Code);
    }

    [Fact]
    public void A_day_after_the_series_ends_is_refused()
    {
        var rule = Rule(RecurrenceFrequency.Daily) with { Until = Anchor.AddDays(2) };

        var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(3));

        Assert.True(applied.IsFailure);
        Assert.Equal("recurrence.not_an_occurrence", applied.Error.Code);
    }

    [Fact]
    public void Completions_stay_sorted_however_out_of_order_they_arrive()
    {
        // The reader refuses an unsorted list, so a writer that appended would produce storage its
        // own reader would reject the next time anybody looked at it.
        var rule = Rule(RecurrenceFrequency.Daily);

        var later = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(9));
        var earlier = RecurrenceWrites.ApplyCompletion(
            RecurrenceRuleJson.Read(later.Value.RuleJson)!,
            Anchor,
            Anchor.AddDays(4));

        var stored = RecurrenceRuleJson.Read(earlier.Value.RuleJson);

        Assert.NotNull(stored);
        Assert.Equal([Anchor.AddDays(4), Anchor.AddDays(9)], stored!.Completed);
    }

    [Fact]
    public void In_order_completion_folds_into_the_watermark_and_stays_small()
    {
        // The bound in practice: a daily series completed in order never accumulates exceptions,
        // which is what lets a years-old series keep fitting the column.
        var rule = Rule(RecurrenceFrequency.Daily);

        for (var day = 0; day < 200; day++)
        {
            var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(day));
            Assert.True(applied.IsSuccess);
            rule = RecurrenceRuleJson.Read(applied.Value.RuleJson)!;
        }

        // Folding happens at the threshold, not on every write, so the watermark trails by
        // whatever has accumulated since the last fold - which is the point: the list is bounded
        // by the threshold rather than by the age of the series.
        Assert.NotNull(rule.CompletedThrough);
        Assert.True(rule.Completed.Length < RecurrenceRuleJson.CompactionThreshold);
        Assert.True(RecurrenceRuleJson.IsWithinBounds(RecurrenceRuleJson.Write(rule)));

        // What must hold regardless of where the watermark happens to sit: every day completed
        // reads as complete, and nothing else does.
        for (var day = 0; day < 200; day++)
        {
            Assert.True(rule.IsCompleted(Anchor.AddDays(day)));
        }

        Assert.False(rule.IsCompleted(Anchor.AddDays(200)));
    }

    [Fact]
    public void Scattered_completion_past_what_folding_can_save_is_refused_rather_than_stored()
    {
        // Every other occurrence completed, so nothing is contiguous and compaction can fold
        // nothing. This is the case the exception bound exists for.
        var rule = Rule(RecurrenceFrequency.Daily) with
        {
            Completed =
            [
                .. Enumerable
                    .Range(0, RecurrenceRuleJson.MaximumCompleted)
                    .Select(index => Anchor.AddDays(1 + (index * 2))),
            ],
        };

        var applied = RecurrenceWrites.ApplyCompletion(
            rule,
            Anchor,
            Anchor.AddDays(1 + (RecurrenceRuleJson.MaximumCompleted * 2)));

        Assert.True(applied.IsFailure);
        Assert.Equal("recurrence.too_many_completions", applied.Error.Code);
    }

    [Fact]
    public void Whatever_the_guard_emits_is_within_the_bound_the_column_enforces()
    {
        // The guard and the CHECK must agree, or one of them is decorative: everything that gets
        // past here has to be storable, and the database must never be the thing that says no.
        var rule = Rule(RecurrenceFrequency.Daily);

        for (var index = 0; index < 150; index++)
        {
            // Every third occurrence, so the list grows without folding for a long time.
            var applied = RecurrenceWrites.ApplyCompletion(rule, Anchor, Anchor.AddDays(index * 3));
            if (applied.IsFailure)
            {
                Assert.Equal("recurrence.too_many_completions", applied.Error.Code);
                return;
            }

            if (applied.Value.RuleJson is { } json)
            {
                Assert.True(RecurrenceRuleJson.IsWithinBounds(json));
                rule = RecurrenceRuleJson.Read(json)!;
            }
        }

        Assert.True(RecurrenceRuleJson.IsWithinBounds(RecurrenceRuleJson.Write(rule)));
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
