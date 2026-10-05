using System.Collections.Immutable;
using Nix.Domain.Primitives;

namespace Nix.Domain.Recurrence;

/// <summary>What a completion attempt produced, when it did not fail.</summary>
public enum RecurrenceCompletionOutcome
{
    /// <summary>
    /// The rule changed - <see cref="RecurrenceCompletion.RuleJson"/> is the JSON to store.
    /// </summary>
    Prepared = 0,

    /// <summary>
    /// The occurrence was already completed - at or below the watermark, or already in the
    /// exception list. Idempotent, not a failure: nothing changed and there is nothing to store.
    /// </summary>
    AlreadyComplete = 1,
}

/// <summary>
/// What <see cref="RecurrenceWrites.ApplyCompletion"/> produced: which of the two non-failure
/// outcomes happened, and the JSON to store when one changed anything.
/// </summary>
/// <param name="Outcome">Which outcome this is.</param>
/// <param name="RuleJson">
/// The rule to store, or <see langword="null"/> when <paramref name="Outcome"/> is
/// <see cref="RecurrenceCompletionOutcome.AlreadyComplete"/> - there is nothing to write.
/// </param>
public readonly record struct RecurrenceCompletion(RecurrenceCompletionOutcome Outcome, string? RuleJson);

/// <summary>
/// Stable expected failures for recurrence writes, named as what a caller can act on rather than
/// as which check inside this file produced them.
/// </summary>
public static class RecurrenceErrors
{
    /// <summary>The written rule does not fit within <see cref="RecurrenceRuleJson.MaximumBytes"/>.</summary>
    public static NixError TooLarge(string message) => new("recurrence.rule_too_large", message);

    /// <summary>The day named is not one the series actually lands on.</summary>
    public static NixError NotAnOccurrence(string message) => new("recurrence.not_an_occurrence", message);

    /// <summary>
    /// Completing this occurrence would leave more than <see cref="RecurrenceRuleJson.MaximumCompleted"/>
    /// out-of-order completions even after folding the contiguous ones into the watermark.
    /// </summary>
    public static NixError TooManyCompletions(string message) => new("recurrence.too_many_completions", message);
}

/// <summary>
/// The single guard every recurrence write crosses, in either direction: authoring a rule, or
/// completing one occurrence of it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Pure and I/O-free, like the rest of this namespace.</b> Nothing here reads or writes storage;
/// callers hand this a <see cref="RecurrenceRule"/> and get back either the JSON to store or a
/// reason it was refused, and it is the caller's job to persist that answer through
/// <c>IRecurrenceStore</c>.
/// </para>
/// <para>
/// <b>The bound this enforces is not a backstop, it is the check.</b> The <c>TaskSemantics</c>
/// migration's <c>item_recurrence_bounded</c> CHECK constraint exists only so a write that forgot
/// this guard fails loudly instead of storing something unbounded; the migration's own remark
/// names this file as the guard it is standing in for. Every code path that can write
/// <c>item.recurrence</c> must go through <see cref="PrepareRule"/> or
/// <see cref="ApplyCompletion"/> first, so a bounds violation is a mapped <see cref="NixError"/>
/// with a stable code, never a constraint violation surfacing as a 500.
/// </para>
/// <para>
/// <b>The round trip is the invariant.</b> <see cref="RecurrenceRuleJson.Read"/> refuses a rule
/// whose <c>Completed</c> is not sorted ascending and strictly above <c>CompletedThrough</c> - so a
/// write that produced one would be unreadable by its own reader the moment it was stored. Both
/// methods here maintain that ordering by construction rather than checking it afterwards: there is
/// no path through either one that can produce the shape the reader would refuse.
/// </para>
/// </remarks>
public static class RecurrenceWrites
{
    /// <summary>
    /// Writes a rule for storage, refusing it when the result would not fit.
    /// </summary>
    /// <param name="rule">The rule to write.</param>
    /// <returns>The JSON to store, or a refusal.</returns>
    /// <remarks>
    /// This is the only check made here: whatever validated <paramref name="rule"/>'s own fields
    /// (interval range, weekday shape, and so on) has already run by the time a rule reaches this
    /// method. What this method alone can decide is whether the written form fits the column's
    /// bound, which is a fact about the JSON, not about the rule's fields in isolation.
    /// </remarks>
    public static Result<string> PrepareRule(RecurrenceRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);

        var json = RecurrenceRuleJson.Write(rule);
        return RecurrenceRuleJson.IsWithinBounds(json)
            ? Result.Success(json)
            : Result.Failure<string>(RecurrenceErrors.TooLarge(
                $"This rule needs more than {RecurrenceRuleJson.MaximumBytes} bytes to store; it "
                + "carries too many completion exceptions to fit."));
    }

    /// <summary>
    /// Decides whether completing one occurrence is possible and, when it is, prepares the rule to
    /// store.
    /// </summary>
    /// <param name="rule">The rule as currently stored.</param>
    /// <param name="anchor">The series' anchor - the item's own due date.</param>
    /// <param name="occurredOn">The occurrence day being completed.</param>
    /// <returns>
    /// The prepared rule when the completion is new; <see cref="RecurrenceCompletionOutcome.AlreadyComplete"/>
    /// when it was already done; or a refusal when the day is not one the series lands on, or
    /// completing it would carry too many exceptions.
    /// </returns>
    /// <remarks>
    /// <para>
    /// Checked in this order and for these reasons:
    /// </para>
    /// <list type="number">
    /// <item><description>
    /// <paramref name="occurredOn"/> at or below <c>CompletedThrough</c>, or already listed in
    /// <c>Completed</c>, is answered as already complete - <see cref="RecurrenceRule.IsCompleted"/>
    /// is the one place that question is asked, so this asks it there rather than re-deriving it.
    /// </description></item>
    /// <item><description>
    /// Otherwise, <paramref name="occurredOn"/> must be a day <see cref="RecurrenceExpansion.Occurrences"/>
    /// actually produces for this rule and anchor - checked over a window of exactly that one day,
    /// never by re-deriving the arithmetic here. A day the series does not land on is refused.
    /// </description></item>
    /// <item><description>
    /// The day is inserted into <c>Completed</c> at its sorted position - out-of-order completion
    /// is expected, not an error - and if the list has reached
    /// <see cref="RecurrenceRuleJson.CompactionThreshold"/> entries, <see cref="RecurrenceRuleJson.Compact"/>
    /// folds every contiguous run above the watermark into it. In-order completion compacts on
    /// every write and the list stays empty; this is what keeps a years-old daily series bounded.
    /// </description></item>
    /// <item><description>
    /// If, even after folding, more than <see cref="RecurrenceRuleJson.MaximumCompleted"/> exceptions
    /// remain, the completion is refused rather than stored - scattered, non-contiguous completion
    /// at that scale is not a workflow this rule shape can carry.
    /// </description></item>
    /// <item><description>
    /// The written JSON must still be within <see cref="RecurrenceRuleJson.MaximumBytes"/>, checked
    /// exactly as <see cref="PrepareRule"/> checks it, or the completion is refused.
    /// </description></item>
    /// </list>
    /// </remarks>
    public static Result<RecurrenceCompletion> ApplyCompletion(
        RecurrenceRule rule,
        DateOnly anchor,
        DateOnly occurredOn)
    {
        ArgumentNullException.ThrowIfNull(rule);

        if (rule.IsCompleted(occurredOn))
        {
            return Result.Success(new RecurrenceCompletion(RecurrenceCompletionOutcome.AlreadyComplete, null));
        }

        var landsOnThatDay = RecurrenceExpansion.Occurrences(rule, anchor, occurredOn, occurredOn).Any();
        if (!landsOnThatDay)
        {
            return Result.Failure<RecurrenceCompletion>(RecurrenceErrors.NotAnOccurrence(
                $"{occurredOn:yyyy-MM-dd} is not a day this series lands on."));
        }

        // occurredOn is neither below the watermark nor already listed (IsCompleted said so above),
        // so inserting it at its sorted position keeps Completed sorted and strictly above
        // CompletedThrough - the invariant RecurrenceRuleJson.Read enforces on the way back in.
        var completed = InsertSorted(rule.Completed, occurredOn);
        var candidate = rule with { Completed = completed };

        if (completed.Length >= RecurrenceRuleJson.CompactionThreshold)
        {
            candidate = RecurrenceRuleJson.Compact(candidate, anchor);
        }

        if (candidate.Completed.Length > RecurrenceRuleJson.MaximumCompleted)
        {
            return Result.Failure<RecurrenceCompletion>(RecurrenceErrors.TooManyCompletions(
                $"Completing {occurredOn:yyyy-MM-dd} would leave more than "
                + $"{RecurrenceRuleJson.MaximumCompleted} completions that do not fold into the "
                + "watermark."));
        }

        var json = RecurrenceRuleJson.Write(candidate);
        if (!RecurrenceRuleJson.IsWithinBounds(json))
        {
            return Result.Failure<RecurrenceCompletion>(RecurrenceErrors.TooLarge(
                $"Completing {occurredOn:yyyy-MM-dd} needs more than "
                + $"{RecurrenceRuleJson.MaximumBytes} bytes to store."));
        }

        return Result.Success(new RecurrenceCompletion(RecurrenceCompletionOutcome.Prepared, json));
    }

    /// <summary>Inserts a day into an already-sorted, distinct list, keeping both properties.</summary>
    /// <param name="days">The current list, ascending and not containing <paramref name="day"/>.</param>
    /// <param name="day">The day to add.</param>
    /// <returns>The list with <paramref name="day"/> inserted at its sorted position.</returns>
    private static ImmutableArray<DateOnly> InsertSorted(ImmutableArray<DateOnly> days, DateOnly day)
    {
        var builder = ImmutableArray.CreateBuilder<DateOnly>(days.Length + 1);
        var inserted = false;

        foreach (var existing in days)
        {
            if (!inserted && day < existing)
            {
                builder.Add(day);
                inserted = true;
            }

            builder.Add(existing);
        }

        if (!inserted)
        {
            builder.Add(day);
        }

        return builder.MoveToImmutable();
    }
}
