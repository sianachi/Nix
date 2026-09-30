using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Automations;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Automations;

/// <summary>
/// Backs <see cref="IAutomationRuleStore"/> with row-level-security-scoped EF reads and plain SQL
/// writes: every call runs inside a session already scoped to the rule's owner (a request, or the
/// dispatcher's per-trigger session), so the owner policy alone decides what is visible.
/// </summary>
public sealed class AutomationRuleStore(NixDbContext database) : IAutomationRuleStore
{
    public async Task<IReadOnlyList<AutomationRule>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        await database.Set<AutomationRule>()
            .AsNoTracking()
            .Where(rule => rule.WorkspaceId == workspaceId)
            .OrderBy(rule => rule.CreatedAt)
            .ThenBy(rule => rule.Id)
            .Take(AutomationGuards.MaxRulesPerOwnerPerWorkspace * 2)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

    public Task<int> CountAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        database.Set<AutomationRule>()
            .AsNoTracking()
            .CountAsync(rule => rule.WorkspaceId == workspaceId, cancellationToken);

    public Task<AutomationRule?> GetAsync(Guid ruleId, CancellationToken cancellationToken) =>
        database.Set<AutomationRule>()
            .AsNoTracking()
            .SingleOrDefaultAsync(rule => rule.Id == ruleId, cancellationToken);

    public async Task InsertAsync(AutomationRule rule, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rule);
        Guid? scope = rule.ScopeItemId?.Value;
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_rule
                (id, tenant_id, workspace_id, owner_principal_id, name, enabled, scope_item_id, trigger_type,
                 watch_key, trigger, conditions, actions, schema_version, revision, consecutive_failures,
                 disabled_reason, last_run_at, created_at, updated_at)
            VALUES ({rule.Id}, {rule.TenantId.Value}, {rule.WorkspaceId.Value}, {rule.OwnerPrincipalId.Value},
                    {rule.Name}, {rule.Enabled}, {scope}, {rule.TriggerType}, {rule.WatchKey},
                    {rule.Trigger}::jsonb, {rule.Conditions}::jsonb, {rule.Actions}::jsonb, {rule.SchemaVersion},
                    {rule.Revision}, 0, NULL, NULL, {rule.CreatedAt}, {rule.UpdatedAt})
            """, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> ReplaceAsync(AutomationRule rule, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rule);
        Guid? scope = rule.ScopeItemId?.Value;
        var updated = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_rule
               SET name = {rule.Name},
                   enabled = {rule.Enabled},
                   scope_item_id = {scope},
                   trigger_type = {rule.TriggerType},
                   watch_key = {rule.WatchKey},
                   trigger = {rule.Trigger}::jsonb,
                   conditions = {rule.Conditions}::jsonb,
                   actions = {rule.Actions}::jsonb,
                   schema_version = {rule.SchemaVersion},
                   revision = {rule.Revision},
                   consecutive_failures = {rule.ConsecutiveFailures},
                   disabled_reason = {rule.DisabledReason},
                   updated_at = {rule.UpdatedAt}
             WHERE tenant_id = {rule.TenantId.Value}
               AND id = {rule.Id}
               AND revision = {expectedRevision}
            """, cancellationToken).ConfigureAwait(false);
        return updated == 1;
    }

    public async Task<bool> DeleteAsync(Guid ruleId, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM automation_rule WHERE id = {ruleId}", cancellationToken).ConfigureAwait(false) == 1;

    public Task RecordSuccessAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_rule
               SET consecutive_failures = 0, last_run_at = {at}
             WHERE tenant_id = {tenantId.Value} AND id = {ruleId}
            """, cancellationToken);

    public async Task<AutomationFailureOutcome?> RecordFailureAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken)
    {
        // One statement: two failures racing each other still count twice, and only the one that
        // crosses the bound sees the rule turn off (the WHERE enabled keeps a later failure on an
        // already-disabled rule from reporting a second transition).
        var rows = await database.Database.SqlQuery<FailureRow>($"""
            UPDATE automation_rule
               SET consecutive_failures = consecutive_failures + 1,
                   last_run_at = {at},
                   enabled = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN false ELSE enabled END,
                   disabled_reason = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN 'repeated_failures' ELSE disabled_reason END,
                   revision = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN revision + 1 ELSE revision END,
                   updated_at = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN {at} ELSE updated_at END
             WHERE tenant_id = {tenantId.Value} AND id = {ruleId} AND enabled
            RETURNING consecutive_failures AS "Failures", NOT enabled AS "Disabled", revision AS "Revision"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Count == 0 ? null : new AutomationFailureOutcome(rows[0].Failures, rows[0].Disabled, rows[0].Revision);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record FailureRow(int Failures, bool Disabled, long Revision);
}

/// <summary>Backs <see cref="IAutomationRunStore"/> under the owner's row-level security.</summary>
public sealed class AutomationRunStore(NixDbContext database) : IAutomationRunStore
{
    public async Task<bool> TryInsertAsync(AutomationRun run, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(run);
        var origin = AutomationStorage.ToText(run.Origin);
        var status = AutomationStorage.ToText(run.Status);
        var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_run
                (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin,
                 depth, status, detail, created_at)
            VALUES ({run.Id}, {run.TenantId.Value}, {run.RuleId}, {run.OwnerPrincipalId.Value}, {run.WorkspaceId.Value},
                    {run.ItemId}, {run.TriggerKey}, {origin}, {run.Depth}, {status}, {run.Detail}::jsonb, {run.CreatedAt})
            ON CONFLICT (tenant_id, rule_id, trigger_key) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        return inserted == 1;
    }

    public Task UpdateStatusAsync(TenantId tenantId, Guid runId, AutomationRunStatus status, string? detailJson, CancellationToken cancellationToken)
    {
        var text = AutomationStorage.ToText(status);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_run SET status = {text}, detail = {detailJson}::jsonb
             WHERE tenant_id = {tenantId.Value} AND id = {runId}
            """, cancellationToken);
    }

    public async Task<IReadOnlyList<AutomationRun>> PageAsync(
        TenantId tenantId, Guid ruleId, (DateTimeOffset CreatedAt, Guid Id)? before, int limit, CancellationToken cancellationToken)
    {
        var query = database.Set<AutomationRun>()
            .AsNoTracking()
            .Where(run => run.TenantId == tenantId && run.RuleId == ruleId);
        if (before is { } cursor)
        {
            query = query.Where(run => run.CreatedAt < cursor.CreatedAt
                || (run.CreatedAt == cursor.CreatedAt && run.Id.CompareTo(cursor.Id) < 0));
        }

        return await query
            .OrderByDescending(run => run.CreatedAt)
            .ThenByDescending(run => run.Id)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    public Task<AutomationRun?> GetAsync(TenantId tenantId, Guid runId, CancellationToken cancellationToken) =>
        database.Set<AutomationRun>()
            .AsNoTracking()
            .SingleOrDefaultAsync(run => run.TenantId == tenantId && run.Id == runId, cancellationToken);

    public Task<int> CountWorkingRunsSinceAsync(TenantId tenantId, Guid ruleId, DateTimeOffset since, CancellationToken cancellationToken) =>
        database.Set<AutomationRun>()
            .AsNoTracking()
            .Where(run => run.TenantId == tenantId && run.RuleId == ruleId && run.CreatedAt >= since)
            .Where(run => run.Status == AutomationRunStatus.Succeeded
                || run.Status == AutomationRunStatus.Noop
                || run.Status == AutomationRunStatus.Failed)
            .Take(AutomationGuards.PerRuleHourly + 1)
            .CountAsync(cancellationToken);

    public Task<int> TrimAsync(TenantId tenantId, Guid ruleId, int keep, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM automation_run doomed
             WHERE doomed.tenant_id = {tenantId.Value}
               AND doomed.rule_id = {ruleId}
               AND doomed.id IN (
                   SELECT run.id
                     FROM automation_run run
                    WHERE run.tenant_id = {tenantId.Value} AND run.rule_id = {ruleId}
                    ORDER BY run.created_at DESC, run.id DESC
                   OFFSET {keep})
            """, cancellationToken);

    public Task<AutomationItemState?> GetItemStateAsync(TenantId tenantId, Guid ruleId, ItemId itemId, CancellationToken cancellationToken) =>
        database.Set<AutomationItemState>()
            .AsNoTracking()
            .SingleOrDefaultAsync(state => state.TenantId == tenantId && state.RuleId == ruleId && state.ItemId == itemId, cancellationToken);

    public Task UpsertItemStateAsync(AutomationItemState state, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(state);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_item_state (tenant_id, rule_id, item_id, owner_principal_id, last_value_hash, last_fired_at)
            VALUES ({state.TenantId.Value}, {state.RuleId}, {state.ItemId.Value}, {state.OwnerPrincipalId.Value},
                    {state.LastValueHash}, {state.LastFiredAt})
            ON CONFLICT (tenant_id, rule_id, item_id) DO UPDATE
               SET last_value_hash = EXCLUDED.last_value_hash, last_fired_at = EXCLUDED.last_fired_at
            """, cancellationToken);
    }
}
