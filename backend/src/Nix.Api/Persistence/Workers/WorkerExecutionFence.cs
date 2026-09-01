using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions.Workers;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Workers;

/// <summary>Uses the tenant-scoped unit-of-work transaction to hold one live worker lease.</summary>
public sealed class WorkerExecutionFence(NixDbContext database) : IWorkerExecutionFence
{
    private const string FenceSql = "SELECT nix_fence_worker_execution(@job_id, @owner, @kind, @tenant_id, @workspace_id, @actor_id)";

    /// <inheritdoc />
    public async ValueTask<bool> HoldAsync(
        Guid jobId,
        string owner,
        WorkerExecutionAuthorization authorization,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authorization);
        if (jobId == Guid.Empty
            || string.IsNullOrWhiteSpace(owner)
            || owner.Length > 128
            || owner.Any(char.IsControl)
            || string.IsNullOrWhiteSpace(authorization.Kind))
        {
            return false;
        }

        if (database.Database.GetDbConnection() is not NpgsqlConnection connection
            || database.Database.CurrentTransaction?.GetDbTransaction() is not NpgsqlTransaction transaction)
        {
            throw new InvalidOperationException("A worker execution fence requires the active Npgsql unit-of-work transaction.");
        }

        var command = new NpgsqlCommand(FenceSql, connection, transaction);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<Guid>("job_id", NpgsqlDbType.Uuid)
            {
                TypedValue = jobId,
            });
            command.Parameters.Add(new NpgsqlParameter<string>("owner", NpgsqlDbType.Text)
            {
                TypedValue = owner,
            });
            command.Parameters.Add(new NpgsqlParameter<string>("kind", NpgsqlDbType.Text)
            {
                TypedValue = authorization.Kind,
            });
            command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid)
            {
                TypedValue = authorization.TenantId,
            });
            command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid)
            {
                Value = authorization.WorkspaceId is { } workspaceId ? workspaceId : DBNull.Value,
            });
            command.Parameters.Add(new NpgsqlParameter<Guid>("actor_id", NpgsqlDbType.Uuid)
            {
                TypedValue = authorization.ActorId,
            });
            return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is true;
        }
    }
}
