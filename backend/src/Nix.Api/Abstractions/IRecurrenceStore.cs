using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>What <see cref="IRecurrenceStore.SetRuleAsync"/> did.</summary>
public enum RecurrenceWriteOutcome
{
    /// <summary>The rule was stored - set to the given JSON, or cleared when it was <see langword="null"/>.</summary>
    Written = 0,

    /// <summary>No such item, or it is not visible to this session.</summary>
    ItemNotFound = 1,
}

/// <summary>What <see cref="IRecurrenceStore.CompleteOccurrenceAsync"/> did.</summary>
public enum OccurrenceCompletionOutcome
{
    /// <summary>The prepared rule JSON was written; the stored rule changed.</summary>
    Completed = 0,

    /// <summary>
    /// The stored rule already matched the JSON handed in; nothing was written. Idempotent, not a
    /// failure - a caller retrying a completion it already made sees this, not an error.
    /// </summary>
    AlreadyComplete = 1,

    /// <summary>No such item, or it is not visible to this session.</summary>
    ItemNotFound = 2,

    /// <summary>The item carries no recurrence rule, so there is no series to complete an occurrence of.</summary>
    NotRecurring = 3,
}

/// <summary>
/// Persistence for one item's recurrence rule: the single seam every recurrence read and write
/// crosses to reach storage.
/// </summary>
/// <remarks>
/// <para>
/// A port for the reason every store here is one - use cases live in this assembly and the
/// implementation needs EF Core and Npgsql, which only Infrastructure may reference. That is the
/// justification the interface guardrail asks for; there is no second implementation and none is
/// planned.
/// </para>
/// <para>
/// <b>Every method is scoped implicitly to the actor and tenant the session context established;
/// neither travels as a parameter.</b> The unit of work publishes both to Postgres as
/// transaction-local settings that row-level security and any audit stamp read from - see
/// <see cref="IItemTree"/> and <see cref="IWorkspaceCalendar"/>, which word this the same way for
/// the tenant. A parameter here would be a second source of truth for the same fact, and the two
/// disagreeing is a cross-tenant write.
/// </para>
/// <para>
/// <b>The caller decides; the store only persists.</b> <see cref="CompleteOccurrenceAsync"/> takes
/// a rule already prepared by the caller - the domain guard is what decided an occurrence was
/// completable, folded the completions, and checked the bounds - so this store's own "did anything
/// change" answer is a comparison against what is already stored, never a second evaluation of the
/// rule itself.
/// </para>
/// </remarks>
public interface IRecurrenceStore
{
    /// <summary>Replaces an item's stored recurrence rule.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="ruleJson">
    /// The rule to store, written by <c>RecurrenceRuleJson.Write</c> and bounds-checked by
    /// <c>RecurrenceWrites.PrepareRule</c>, or <see langword="null"/> to clear it - the item stops
    /// repeating.
    /// </param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Whether the rule was written, or that the item could not be found.</returns>
    public ValueTask<RecurrenceWriteOutcome> SetRuleAsync(
        ItemId itemId,
        string? ruleJson,
        CancellationToken cancellationToken);

    /// <summary>Reads an item's stored recurrence rule.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The stored JSON, or <see langword="null"/> when the item has no rule.</returns>
    public ValueTask<string?> ReadRuleAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Persists a completion the caller has already decided and prepared.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="ruleJson">
    /// The rule to store, exactly as <c>RecurrenceWrites.ApplyCompletion</c> produced it - already
    /// folded, already bounds-checked. This method makes no second decision about whether the
    /// occurrence it reflects was completable.
    /// </param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see cref="OccurrenceCompletionOutcome.Completed"/> when the stored rule changed to
    /// <paramref name="ruleJson"/>; <see cref="OccurrenceCompletionOutcome.AlreadyComplete"/> when
    /// the stored rule already matched it and nothing was written; or why neither could happen.
    /// </returns>
    public ValueTask<OccurrenceCompletionOutcome> CompleteOccurrenceAsync(
        ItemId itemId,
        string ruleJson,
        CancellationToken cancellationToken);
}
