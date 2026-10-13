using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workspaces;

namespace Nix.Persistence.Workspaces;

/// <summary>Stores a bounded per-principal arrangement document in the request's RLS transaction.</summary>
public sealed class WorkspaceArrangementStore(NixDbContext db) : IWorkspaceArrangementStore
{
    /// <inheritdoc />
    public async ValueTask<WorkspaceArrangement?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<WorkspaceArrangement>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<bool> SaveAsync(WorkspaceArrangement arrangement, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(arrangement);
        var pinned = arrangement.PinnedWorkspaceIds.ToArray();
        // The insert handles the first-write race; the update below compares the current revision.
        var changed = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO workspace_arrangement (tenant_id, principal_id, groups_json, pinned_workspace_ids, revision)
            SELECT {arrangement.TenantId.Value}, {arrangement.PrincipalId.Value}, {arrangement.GroupsJson}::jsonb, {pinned}, {arrangement.Revision}
            WHERE {expectedRevision} = 0
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        if (changed == 1)
        {
            return true;
        }

        return await db.Set<WorkspaceArrangement>()
            .Where(row => row.TenantId == arrangement.TenantId && row.PrincipalId == arrangement.PrincipalId && row.Revision == expectedRevision)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(row => row.GroupsJson, arrangement.GroupsJson)
                .SetProperty(row => row.PinnedWorkspaceIds, arrangement.PinnedWorkspaceIds)
                .SetProperty(row => row.Revision, arrangement.Revision), cancellationToken)
            .ConfigureAwait(false) == 1;
    }
}
