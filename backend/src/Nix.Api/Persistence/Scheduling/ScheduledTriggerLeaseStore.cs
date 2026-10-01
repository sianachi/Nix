using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the exact <c>nix_lease_due_triggers</c> and <c>nix_finish_trigger</c> SECURITY DEFINER
/// functions directly against the connection pool, the same way
/// <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectOperationStore"/> calls its own finder:
/// no <see cref="NixDbContext"/> session context is established, and none is needed, because
/// FORCE ROW LEVEL SECURITY on <c>scheduled_trigger</c> binds even a table owner, and these
/// functions cross every tenant only because they are owned by the migrator role, which holds
/// BYPASSRLS - SECURITY DEFINER alone would not be enough.
/// </summary>
public sealed class ScheduledTriggerLeaseStore(NpgsqlDataSource dataSource) : IScheduledTriggerLeaseStore
{
    private const string LeaseSql = "SELECT * FROM nix_lease_due_triggers(@limit, @owner, @lease_seconds, @max_attempts, @sources)";
    private const string FinishSql = "SELECT nix_finish_trigger(@tenant_id, @id, @owner, @status, @detail::jsonb)";

    public async Task<IReadOnlyList<DueTrigger>> LeaseDueAsync(
        int limit,
        string owner,
        int leaseSeconds,
        int maxAttempts,
        IReadOnlyList<string>? sources,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        if (leaseSeconds is < 5 or > 300)
        {
            throw new ArgumentOutOfRangeException(nameof(leaseSeconds));
        }
        if (maxAttempts is < 1 or > 20)
        {
            throw new ArgumentOutOfRangeException(nameof(maxAttempts));
        }

        var results = new List<DueTrigger>(limit);
        var command = dataSource.CreateCommand(LeaseSql);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            command.Parameters.Add(new NpgsqlParameter<string>("owner", NpgsqlDbType.Text) { TypedValue = owner });
            command.Parameters.Add(new NpgsqlParameter<int>("lease_seconds", NpgsqlDbType.Integer) { TypedValue = leaseSeconds });
            command.Parameters.Add(new NpgsqlParameter<int>("max_attempts", NpgsqlDbType.Integer) { TypedValue = maxAttempts });
            command.Parameters.Add(new NpgsqlParameter("sources", NpgsqlDbType.Array | NpgsqlDbType.Text)
            {
                Value = sources is null ? DBNull.Value : sources.ToArray(),
            });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var workspaceId = await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false)
                        ? (WorkspaceId?)null
                        : WorkspaceId.From(reader.GetGuid(2));
                    var sourceItemId = await reader.IsDBNullAsync(6, cancellationToken).ConfigureAwait(false)
                        ? (Guid?)null
                        : reader.GetGuid(6);
                    var ruleId = await reader.IsDBNullAsync(7, cancellationToken).ConfigureAwait(false)
                        ? (Guid?)null
                        : reader.GetGuid(7);
                    results.Add(new DueTrigger(
                        TenantId.From(reader.GetGuid(0)),
                        reader.GetGuid(1),
                        workspaceId,
                        PrincipalId.From(reader.GetGuid(3)),
                        TriggerStorage.KindFromText(reader.GetString(4)),
                        reader.GetString(5),
                        sourceItemId,
                        ruleId,
                        await reader.GetFieldValueAsync<DateTimeOffset>(8, cancellationToken).ConfigureAwait(false),
                        reader.GetString(9),
                        reader.GetInt32(10)));
                }
            }
        }
        return results;
    }

    public async Task<bool> FinishAsync(TenantId tenantId, Guid id, string owner, TriggerStatus status, string? detailJson, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        var command = dataSource.CreateCommand(FinishSql);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid) { TypedValue = tenantId.Value });
            command.Parameters.Add(new NpgsqlParameter<Guid>("id", NpgsqlDbType.Uuid) { TypedValue = id });
            command.Parameters.Add(new NpgsqlParameter<string>("owner", NpgsqlDbType.Text) { TypedValue = owner });
            command.Parameters.Add(new NpgsqlParameter<string>("status", NpgsqlDbType.Text) { TypedValue = TriggerStorage.ToText(status) });
            command.Parameters.Add(new NpgsqlParameter("detail", NpgsqlDbType.Text)
            {
                Value = (object?)detailJson ?? DBNull.Value,
            });
            var result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            return result is bool value && value;
        }
    }
}
