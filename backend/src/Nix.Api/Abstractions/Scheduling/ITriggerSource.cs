using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Scheduling;

/// <summary>The planning window the dispatcher's <c>TriggerPlanner</c> reconciles this pass.</summary>
/// <param name="Start">The earliest instant a planned trigger may fire.</param>
/// <param name="End">The latest instant a planned trigger may fire (48 hours ahead, per ADR-0051).</param>
public sealed record PlanWindow(DateTimeOffset Start, DateTimeOffset End);

/// <summary>One trigger a source wants planned for a recipient.</summary>
public sealed record DesiredTrigger(
    TenantId TenantId,
    WorkspaceId? WorkspaceId,
    PrincipalId PrincipalId,
    Guid? SourceItemId,
    Guid? RuleId,
    DateTimeOffset FireAt,
    string DedupeKey);

/// <summary>Everything one source wants planned this pass, and whether that is all of it.</summary>
/// <param name="Triggers">The desired triggers the source found.</param>
/// <param name="Complete">
/// Whether <paramref name="Triggers"/> is the source's whole desired set for the window. A source
/// that stopped at its page cap returns <see langword="false"/>: its missing candidates are not
/// "no longer desired", so the planner still upserts what it has but must not cancel anything for
/// that source this pass.
/// </param>
public sealed record TriggerPlan(IReadOnlyList<DesiredTrigger> Triggers, bool Complete)
{
    /// <summary>Gets a complete plan with nothing to schedule.</summary>
    public static TriggerPlan Empty { get; } = new([], Complete: true);
}

/// <summary>What happened when the dispatcher re-verified and fired a trigger.</summary>
public enum TriggerFireStatus
{
    /// <summary>The source's rule was still true, and its action ran.</summary>
    Fired,

    /// <summary>Re-verification found the rule no longer true (trashed, disabled, permission lost).</summary>
    Skipped,
}

/// <summary>The result of one fire attempt.</summary>
/// <param name="Status">Whether the trigger fired or was skipped.</param>
/// <param name="Reason">A short, non-user-text reason recorded on the trigger, for either outcome.</param>
public sealed record TriggerOutcome(TriggerFireStatus Status, string Reason)
{
    /// <summary>Creates a fired outcome.</summary>
    public static TriggerOutcome Fired(string reason) => new(TriggerFireStatus.Fired, reason);

    /// <summary>Creates a skipped outcome.</summary>
    public static TriggerOutcome Skipped(string reason) => new(TriggerFireStatus.Skipped, reason);
}

/// <summary>
/// A plug-in that both plans triggers for its <see cref="Kind"/> ahead of time and fires them,
/// re-verified, at the leased instant. The dispatcher resolves the one source whose
/// <see cref="Name"/> matches a leased trigger's recorded source before firing.
/// </summary>
public interface ITriggerSource
{
    /// <summary>
    /// Gets the unique, stable name the dispatcher resolves this source by - lowercase, dotted,
    /// at most 64 characters (for example <c>reminder.due</c>). Recorded on every trigger this
    /// source plans, and the dispatcher's only way of choosing which registered source fires a
    /// leased row: more than one source may share a <see cref="Kind"/>, so <see cref="Kind"/>
    /// alone cannot resolve one. Must be unique across every registered source - checked at
    /// startup, since a collision would make the dispatcher's resolution silently ambiguous.
    /// </summary>
    public string Name { get; }

    /// <summary>Gets the trigger kind this source plans and fires - a display/reporting category, not a dispatch key.</summary>
    public TriggerKind Kind { get; }

    /// <summary>
    /// Gets whether the planner reconciles this source at all. An event-fed source (the automation
    /// property feed, whose rows a database trigger inserts as writes happen) returns
    /// <see langword="false"/>: the planner then never calls <see cref="PlanAsync"/>, upserts and
    /// cancels nothing for it, and does not warn that its plan was incomplete. The dispatcher still
    /// fires its rows by <see cref="Name"/>.
    /// </summary>
    public bool IsPlanned => true;

    /// <summary>
    /// Returns every trigger this source currently wants planned within <paramref name="window"/>,
    /// across whichever recipients it is responsible for, and whether that set is complete. A
    /// source that needs to enumerate more than its own already-scoped data across tenants must be
    /// given a narrow, bounded, SECURITY DEFINER-backed way to do so rather than reading tables
    /// directly.
    /// </summary>
    public Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken);

    /// <summary>
    /// Re-verifies and acts on one leased trigger. Runs inside a transaction already scoped to
    /// the trigger's own tenant, workspace and principal, exactly like
    /// <c>AbandonedObjectReaper</c> scopes each candidate it reaps.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1030:Use events where appropriate", Justification = "FireAsync verifies and acts on a trigger; it is not a .NET event.")]
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken);
}
