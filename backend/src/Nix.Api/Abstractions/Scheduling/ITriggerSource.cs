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
/// re-verified, at the leased instant. Registered per <see cref="TriggerKind"/>; the dispatcher
/// resolves the one source whose <see cref="Kind"/> matches a leased trigger's kind before firing.
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
    /// Returns every trigger this source currently wants planned within <paramref name="window"/>,
    /// across whichever recipients it is responsible for. A source that needs to enumerate more
    /// than its own already-scoped data across tenants must be given a narrow, bounded,
    /// SECURITY DEFINER-backed way to do so rather than reading tables directly - none of the
    /// sources registered in this lane need one.
    /// </summary>
    public Task<IReadOnlyList<DesiredTrigger>> PlanAsync(PlanWindow window, CancellationToken cancellationToken);

    /// <summary>
    /// Re-verifies and acts on one leased trigger. Runs inside a transaction already scoped to
    /// the trigger's own tenant, workspace and principal, exactly like
    /// <c>AbandonedObjectReaper</c> scopes each candidate it reaps.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1030:Use events where appropriate", Justification = "FireAsync verifies and acts on a trigger; it is not a .NET event.")]
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken);
}
