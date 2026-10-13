using Nix.Domain.Identity;
using Nix.Domain.Pets;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Stores a person's provider API keys, one per provider.</summary>
public interface IPetProviderCredentialStore
{
    /// <summary>Reads one provider's credential for the owner, or null.</summary>
    public ValueTask<PetProviderCredential?> FindAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken);

    /// <summary>Lists the owner's credentials (hints only matter to callers).</summary>
    public ValueTask<IReadOnlyList<PetProviderCredential>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Inserts or replaces the owner's credential for a provider.</summary>
    public Task SaveAsync(PetProviderCredential credential, CancellationToken cancellationToken);

    /// <summary>Removes the owner's credential for a provider; false when there was none.</summary>
    public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken);
}
