using Nix.Domain.Identity;
using Nix.Domain.Settings;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Account-owned synced interface settings, merged key by key.</summary>
public interface IPrincipalUiSettingsStore
{
    /// <summary>Reads only the current owner's settings; <see langword="null"/> when never written.</summary>
    public ValueTask<PrincipalUiSettings?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Atomically sets the keys in <paramref name="setJson"/> (a JSON object) and removes
    /// <paramref name="removeKeys"/>, creating the row on first write. Other keys are untouched,
    /// so concurrent writers to different keys never lose each other's change.
    /// </summary>
    public Task<PrincipalUiSettings> MergeAsync(TenantId tenantId, PrincipalId principalId, string setJson, IReadOnlyList<string> removeKeys, CancellationToken cancellationToken);
}
