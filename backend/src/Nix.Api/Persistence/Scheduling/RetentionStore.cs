using Nix.Abstractions.Scheduling;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the <c>nix_purge_old_notifications</c> and <c>nix_purge_finished_triggers</c> SECURITY
/// DEFINER functions directly against the connection pool - the same pattern as
/// <see cref="ScheduledTriggerLeaseStore"/> and <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectOperationStore"/>.
/// </summary>
public sealed class RetentionStore(NpgsqlDataSource dataSource) : IRetentionStore
{
    public Task<int> PurgeOldNotificationsAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_old_notifications(@limit)", limit, cancellationToken);

    public Task<int> PurgeFinishedTriggersAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_finished_triggers(@limit)", limit, cancellationToken);

    public Task<int> PurgeAutomationRunsAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_automation_runs(@limit)", limit, cancellationToken);

    public Task<int> PurgeCalendarSyncLogAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_calendar_sync_log(@limit)", limit, cancellationToken);

    private async Task<int> PurgeAsync(string sql, int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var command = dataSource.CreateCommand(sql);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            var result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            return result is int deleted ? deleted : 0;
        }
    }
}
