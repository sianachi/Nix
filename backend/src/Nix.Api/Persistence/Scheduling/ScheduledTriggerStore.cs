using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Backs <see cref="IScheduledTriggerStore"/> with plain, row-level-security-scoped SQL. Every
/// call here runs inside a session already scoped to the trigger's own tenant and principal (the
/// planner opens one per recipient before upserting or cancelling; the dispatcher's retry backoff
/// reuses the session it scoped to fire the trigger), so no SECURITY DEFINER elevation is needed.
/// </summary>
public sealed class ScheduledTriggerStore(NixDbContext database) : IScheduledTriggerStore
{
    public async Task UpsertPendingAsync(
        TenantId tenantId,
        WorkspaceId? workspaceId,
        PrincipalId principalId,
        TriggerKind kind,
        string source,
        Guid? sourceItemId,
        Guid? ruleId,
        DateTimeOffset fireAt,
        string dedupeKey,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dedupeKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        var id = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        var kindText = TriggerStorage.ToText(kind);
        var pendingText = TriggerStorage.ToText(TriggerStatus.Pending);
        var cancelledText = TriggerStorage.ToText(TriggerStatus.Cancelled);
        Guid? workspaceIdValue = workspaceId?.Value;

        // ON CONFLICT touches the row only while it is pending-and-never-retried, or cancelled: a
        // trigger already leased, fired or skipped must never be resurrected or rescheduled by
        // replanning, but a cancelled one must be revivable - a due date moved away and back, or a
        // rule disabled and re-enabled, is exactly the same dedupe key becoming desired again.
        // Reviving resets attempts and any stale lease fields so it is indistinguishable from a
        // fresh row.
        //
        // A pending row with attempts > 0 is excluded on purpose (ADR-0051 Amendment 2): it is a
        // trigger a fire attempt already failed on, moved back to pending with its fire_at pushed
        // out by the dispatcher's backoff. The very next planning pass, 60 seconds later, would
        // otherwise overwrite that backoff with "now" (or whatever instant the source still
        // computes for it) and reset attempts to 0, so a failing trigger could never actually back
        // off - it would be replanned to "due immediately" before its backoff ever elapsed. Once a
        // retried trigger fires, is skipped for good, or is genuinely no longer desired, it leaves
        // this branch through CancelStaleAsync instead.
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO scheduled_trigger
                (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                 fire_at, dedupe_key, status, attempts, created_at, updated_at)
            VALUES ({tenantId.Value}, {id}, {workspaceIdValue}, {principalId.Value}, {kindText},
                {source}, {sourceItemId}, {ruleId}, {fireAt}, {dedupeKey}, {pendingText}, 0, {now}, {now})
            ON CONFLICT (tenant_id, principal_id, dedupe_key) DO UPDATE SET
                fire_at = EXCLUDED.fire_at,
                workspace_id = EXCLUDED.workspace_id,
                source = EXCLUDED.source,
                source_item_id = EXCLUDED.source_item_id,
                rule_id = EXCLUDED.rule_id,
                status = {pendingText},
                attempts = 0,
                lease_owner = NULL,
                lease_until = NULL,
                detail = NULL,
                updated_at = EXCLUDED.updated_at
            WHERE scheduled_trigger.status = {cancelledText}
               OR (scheduled_trigger.status = {pendingText} AND scheduled_trigger.attempts = 0)
            """, cancellationToken).ConfigureAwait(false);
    }

    public async Task<int> CancelStaleAsync(
        TenantId tenantId,
        WorkspaceId? workspaceId,
        PrincipalId principalId,
        TriggerKind kind,
        string source,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd,
        IReadOnlyCollection<string> desiredDedupeKeys,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        var kindText = TriggerStorage.ToText(kind);
        var now = DateTimeOffset.UtcNow;
        var keys = desiredDedupeKeys.ToArray();
        Guid? workspaceIdValue = workspaceId?.Value;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET status = 'cancelled', updated_at = {now}
             WHERE tenant_id = {tenantId.Value}
               AND principal_id = {principalId.Value}
               AND workspace_id IS NOT DISTINCT FROM {workspaceIdValue}
               AND kind = {kindText}
               AND source = {source}
               AND status = 'pending'
               AND fire_at >= {windowStart}
               AND fire_at < {windowEnd}
               AND NOT (dedupe_key = ANY({keys}))
            """, cancellationToken).ConfigureAwait(false);
    }

    public Task RescheduleAsync(TenantId tenantId, Guid id, DateTimeOffset fireAt, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET fire_at = {fireAt}, updated_at = {DateTimeOffset.UtcNow}
             WHERE tenant_id = {tenantId.Value} AND id = {id} AND status = 'pending'
            """, cancellationToken);
}
