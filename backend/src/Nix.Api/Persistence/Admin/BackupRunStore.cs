using Nix.Abstractions;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Admin;

/// <summary>
/// Calls <c>nix_backup_runs</c> straight on the pool with no session context, as
/// <c>SiteHostnameCheckFinder</c> does: the table is capability-only, reachable by this one
/// definer function and nothing else.
/// </summary>
public sealed class BackupRunStore(NpgsqlDataSource dataSource) : IBackupRunStore
{
    /// <inheritdoc />
    public async Task<IReadOnlyList<BackupRun>> ListAsync(int limit, CancellationToken cancellationToken)
    {
        var found = new List<BackupRun>();
        var command = dataSource.CreateCommand("SELECT * FROM nix_backup_runs(@limit)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    found.Add(new BackupRun(
                        reader.GetGuid(0),
                        await reader.GetFieldValueAsync<DateTimeOffset>(1, cancellationToken).ConfigureAwait(false),
                        await reader.GetFieldValueAsync<DateTimeOffset>(2, cancellationToken).ConfigureAwait(false),
                        reader.GetString(3),
                        reader.GetString(4),
                        await reader.IsDBNullAsync(5, cancellationToken).ConfigureAwait(false) ? null : reader.GetString(5),
                        await reader.IsDBNullAsync(6, cancellationToken).ConfigureAwait(false) ? null : reader.GetInt64(6),
                        await reader.IsDBNullAsync(7, cancellationToken).ConfigureAwait(false) ? null : reader.GetString(7)));
                }
            }
        }

        return found;
    }
}
