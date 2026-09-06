using Nix.Domain.Content;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Account-owned preferences with optimistic concurrency.</summary>
public interface IPetPreferencesStore
{
    /// <summary>Reads only the current owner's preferences.</summary>
    public ValueTask<PetPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Writes only if the expected revision is still current; zero means absent.</summary>
    public Task<bool> SaveAsync(PetPreferences preferences, long expectedRevision, CancellationToken cancellationToken);
}
