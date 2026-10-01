using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Devices registered to receive Web Push, scoped to the session owner.</summary>
public interface IPushSubscriptionStore
{
    /// <summary>Lists the owner's registered devices.</summary>
    public Task<IReadOnlyList<PushSubscription>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Takes a transaction-scoped lock on the owner's registrations, so a count-then-insert under
    /// it cannot race a concurrent registration past the per-principal ceiling.
    /// </summary>
    public Task LockAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Registers a device, or refreshes the existing row for the same endpoint. Returns the saved row.
    /// </summary>
    public Task<PushSubscription> SaveAsync(PushSubscription subscription, CancellationToken cancellationToken);

    /// <summary>Removes a device by its endpoint. Returns <see langword="false"/> when it does not belong to this owner.</summary>
    public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string endpoint, CancellationToken cancellationToken);

    /// <summary>Removes a device by its id (a push service reported it gone). Returns <see langword="false"/> when it does not belong to this owner.</summary>
    public Task<bool> RemoveByIdAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken);

    /// <summary>Records a successful delivery: clears the consecutive-failure count.</summary>
    public Task RecordDeliveredAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken);

    /// <summary>
    /// Records a failed delivery attempt, removing the device once it has failed five times in a
    /// row.
    /// </summary>
    public Task RecordFailedAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken);
}
