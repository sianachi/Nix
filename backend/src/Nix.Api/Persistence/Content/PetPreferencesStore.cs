using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Content;

/// <summary>Stores a bounded account document in the request's RLS transaction.</summary>
public sealed class PetPreferencesStore(NixDbContext db) : IPetPreferencesStore
{
    /// <inheritdoc />
    public async ValueTask<PetPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<PetPreferences>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<bool> SaveAsync(PetPreferences preferences, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(preferences);
        // The insert handles the first-write race; the update below compares the current revision.
        var changed = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_preferences (tenant_id, principal_id, settings, revision)
            SELECT {preferences.TenantId.Value}, {preferences.PrincipalId.Value},
                CAST({preferences.SettingsJson} AS jsonb), {preferences.Revision}
            WHERE {expectedRevision} = 0
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        if (changed == 1)
        {
            return true;
        }

        return await db.Set<PetPreferences>()
            .Where(row => row.TenantId == preferences.TenantId && row.PrincipalId == preferences.PrincipalId && row.Revision == expectedRevision)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(row => row.SettingsJson, preferences.SettingsJson)
                .SetProperty(row => row.Revision, preferences.Revision), cancellationToken)
            .ConfigureAwait(false) == 1;
    }
}
