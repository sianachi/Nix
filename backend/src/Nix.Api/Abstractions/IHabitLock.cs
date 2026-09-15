using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>Serializes habit settings and check-ins until the caller's transaction completes.</summary>
/// <remarks>
/// The Postgres adapter uses a transaction-scoped advisory lock. A replacement persistence adapter
/// must provide the same transaction lifetime and cross-process exclusion before replacing it;
/// process-local locks are suitable only for isolated test fakes, never production.
/// </remarks>
public interface IHabitLock
{
    /// <summary>Acquires the lock inside the active Core unit of work.</summary>
    public ValueTask AcquireAsync(ItemId itemId, CancellationToken cancellationToken);
}
