using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Settings;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Settings;

/// <summary>Stores a bounded per-principal settings document in the request's RLS transaction.</summary>
public sealed class PrincipalUiSettingsStore(NixDbContext db) : IPrincipalUiSettingsStore
{
    /// <inheritdoc />
    public async ValueTask<PrincipalUiSettings?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<PrincipalUiSettings>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<PrincipalUiSettings> MergeAsync(
        TenantId tenantId, PrincipalId principalId, string setJson, IReadOnlyList<string> removeKeys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(setJson);
        ArgumentNullException.ThrowIfNull(removeKeys);
        var remove = removeKeys.ToArray();
        // One statement: the upsert covers the first-write race and the || / - merge is atomic per row.
        var rows = await db.Database.SqlQuery<MergedRow>($"""
            INSERT INTO principal_ui_settings (tenant_id, principal_id, settings, revision)
            VALUES ({tenantId.Value}, {principalId.Value}, {setJson}::jsonb, 1)
            ON CONFLICT (tenant_id, principal_id) DO UPDATE SET
                settings = (principal_ui_settings.settings || EXCLUDED.settings) - {remove}::text[],
                revision = principal_ui_settings.revision + 1
            RETURNING settings::text AS "Settings", revision AS "Revision"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        var merged = rows.Single();
        return new PrincipalUiSettings { TenantId = tenantId, PrincipalId = principalId, SettingsJson = merged.Settings, Revision = merged.Revision };
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record MergedRow(string Settings, long Revision);
}
