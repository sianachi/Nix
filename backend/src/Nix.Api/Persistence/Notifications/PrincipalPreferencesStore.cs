using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Notifications;

/// <summary>Stores a bounded account document in the request's RLS transaction.</summary>
public sealed class PrincipalPreferencesStore(NixDbContext db) : IPrincipalPreferencesStore
{
    /// <inheritdoc />
    public async ValueTask<PrincipalPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<PrincipalPreferences>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<bool> SaveAsync(PrincipalPreferences preferences, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(preferences);
        var mutedContainerIds = preferences.MutedContainerIds.ToArray();
        // The insert handles the first-write race; the update below compares the current revision.
        var changed = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO principal_preferences (
                tenant_id, principal_id, time_zone, quiet_start, quiet_end,
                due_reminder_time, due_reminders, habit_reminders, muted_container_ids, revision)
            SELECT {preferences.TenantId.Value}, {preferences.PrincipalId.Value}, {preferences.TimeZone},
                {preferences.QuietStart}, {preferences.QuietEnd}, {preferences.DueReminderTime},
                {preferences.DueReminders}, {preferences.HabitReminders}, {mutedContainerIds}, {preferences.Revision}
            WHERE {expectedRevision} = 0
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        if (changed == 1)
        {
            return true;
        }

        return await db.Set<PrincipalPreferences>()
            .Where(row => row.TenantId == preferences.TenantId && row.PrincipalId == preferences.PrincipalId && row.Revision == expectedRevision)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(row => row.TimeZone, preferences.TimeZone)
                .SetProperty(row => row.QuietStart, preferences.QuietStart)
                .SetProperty(row => row.QuietEnd, preferences.QuietEnd)
                .SetProperty(row => row.DueReminderTime, preferences.DueReminderTime)
                .SetProperty(row => row.DueReminders, preferences.DueReminders)
                .SetProperty(row => row.HabitReminders, preferences.HabitReminders)
                .SetProperty(row => row.MutedContainerIds, preferences.MutedContainerIds)
                .SetProperty(row => row.Revision, preferences.Revision), cancellationToken)
            .ConfigureAwait(false) == 1;
    }
}
