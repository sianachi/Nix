using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Account-owned reminder and notification preferences with optimistic concurrency.</summary>
public interface IPrincipalPreferencesStore
{
    /// <summary>Reads only the current owner's preferences.</summary>
    public ValueTask<PrincipalPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Writes only if the expected revision is still current; zero means absent.</summary>
    public Task<bool> SaveAsync(PrincipalPreferences preferences, long expectedRevision, CancellationToken cancellationToken);
}
