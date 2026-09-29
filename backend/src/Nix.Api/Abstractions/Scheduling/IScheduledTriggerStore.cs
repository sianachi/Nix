using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Scheduling;

/// <summary>One due trigger the dispatcher leased, resolved from any tenant.</summary>
public sealed record DueTrigger(
    TenantId TenantId,
    Guid Id,
    WorkspaceId? WorkspaceId,
    PrincipalId PrincipalId,
    TriggerKind Kind,
    Guid? SourceItemId,
    Guid? RuleId,
    DateTimeOffset FireAt,
    string DedupeKey,
    int Attempts);

/// <summary>
/// The dispatcher's cross-tenant lease and finish operations, backed by the
/// <c>nix_lease_due_triggers</c> and <c>nix_finish_trigger</c> SECURITY DEFINER functions - the
/// only cross-tenant reader of <c>scheduled_trigger</c>, exactly as the abandoned-object finder is
/// for expiry.
/// </summary>
public interface IScheduledTriggerLeaseStore
{
    /// <summary>
    /// Leases up to <paramref name="limit"/> due or lease-expired triggers, marking each leased by
    /// <paramref name="owner"/> for <paramref name="leaseSeconds"/>.
    /// </summary>
    public Task<IReadOnlyList<DueTrigger>> LeaseDueAsync(int limit, string owner, int leaseSeconds, CancellationToken cancellationToken);

    /// <summary>
    /// Finishes a trigger this <paramref name="owner"/> currently leases, moving it to
    /// <paramref name="status"/> (<c>fired</c>, <c>skipped</c>, or back to <c>pending</c> for a
    /// retry) and recording <paramref name="detail"/>. Returns <see langword="false"/> when the
    /// lease was lost (another replica already reclaimed it after expiry).
    /// </summary>
    public Task<bool> FinishAsync(TenantId tenantId, Guid id, string owner, TriggerStatus status, string? detailJson, CancellationToken cancellationToken);
}

/// <summary>
/// Ordinary, RLS-scoped reads and writes against one recipient's own triggers - used by the
/// planner (already scoped to the trigger's owner by the time it upserts or cancels) and by the
/// dispatcher's retry backoff (already scoped to the leased row's own owner).
/// </summary>
public interface IScheduledTriggerStore
{
    /// <summary>
    /// Upserts a pending trigger by <c>(tenant_id, principal_id, dedupe_key)</c>: creates it, or
    /// moves its <c>fire_at</c> forward if it is still pending. A trigger already leased, fired,
    /// skipped or cancelled is left alone - replanning must never resurrect or reschedule a row
    /// the dispatcher is already handling or has finished.
    /// </summary>
    public Task UpsertPendingAsync(
        TenantId tenantId,
        WorkspaceId? workspaceId,
        PrincipalId principalId,
        TriggerKind kind,
        Guid? sourceItemId,
        Guid? ruleId,
        DateTimeOffset fireAt,
        string dedupeKey,
        CancellationToken cancellationToken);

    /// <summary>
    /// Cancels every pending trigger of <paramref name="kind"/> for this recipient in
    /// <paramref name="workspaceId"/> whose <c>fire_at</c> falls in
    /// <paramref name="windowStart"/>..<paramref name="windowEnd"/> and whose dedupe key is not in
    /// <paramref name="desiredDedupeKeys"/> - the source no longer produces it.
    /// </summary>
    /// <remarks>
    /// Scoped by workspace as well as principal and kind: a principal can have triggers of the
    /// same kind in more than one workspace (or none, for a personal reminder), and reconciling
    /// one workspace's desired set must never cancel another's rows that this planning pass never
    /// looked at.
    /// </remarks>
    public Task<int> CancelStaleAsync(
        TenantId tenantId,
        WorkspaceId? workspaceId,
        PrincipalId principalId,
        TriggerKind kind,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd,
        IReadOnlyCollection<string> desiredDedupeKeys,
        CancellationToken cancellationToken);

    /// <summary>Moves a pending trigger's <c>fire_at</c> forward, for retry backoff after a failed fire.</summary>
    public Task RescheduleAsync(TenantId tenantId, Guid id, DateTimeOffset fireAt, CancellationToken cancellationToken);
}
