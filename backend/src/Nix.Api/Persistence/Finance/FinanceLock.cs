using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Finance;

/// <summary>A transaction-scoped advisory lock keyed on the finance root.</summary>
public sealed class FinanceLock(NixDbContext database) : IFinanceLock
{
    public async ValueTask AcquireWorkspaceTopologyAsync(WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        EnsureTransaction();
        await database.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
            [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = $"finance-workspace:{workspaceId.Value:D}" }],
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask AcquireAsync(ItemId rootId, CancellationToken cancellationToken)
    {
        EnsureTransaction();
        await database.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
            [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = $"finance:{rootId.Value:D}" }],
            cancellationToken).ConfigureAwait(false);
    }

    private void EnsureTransaction()
    {
        ArgumentNullException.ThrowIfNull(database);
        if (database.Database.CurrentTransaction is null)
        {
            throw new InvalidOperationException("Finance writes require an active Core transaction.");
        }
    }
}
