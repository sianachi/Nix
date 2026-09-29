using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Devices registered to receive Web Push, scoped to the session owner.</summary>
public interface IPushSubscriptionStore
{
    /// <summary>Lists the owner's registered devices.</summary>
    public Task<IReadOnlyList<PushSubscription>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Counts the owner's registered devices, to enforce the per-principal ceiling before an insert.</summary>
    public Task<int> CountAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Registers a device, or refreshes the existing row for the same endpoint. Returns the saved row.
    /// </summary>
    public Task<PushSubscription> SaveAsync(PushSubscription subscription, CancellationToken cancellationToken);

    /// <summary>Removes a device by its endpoint. Returns <see langword="false"/> when it does not belong to this owner.</summary>
    public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string endpoint, CancellationToken cancellationToken);
}
