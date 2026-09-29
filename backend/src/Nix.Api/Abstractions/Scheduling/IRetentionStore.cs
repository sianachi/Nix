namespace Nix.Abstractions.Scheduling;

/// <summary>
/// Bounded, cross-tenant deletion of expired notifications and finished triggers - the one
/// legitimate cross-principal writer for each, backed by a SECURITY DEFINER function exactly as
/// the lease and finish operations are.
/// </summary>
public interface IRetentionStore
{
    /// <summary>Deletes up to <paramref name="limit"/> notifications older than 90 days. Returns how many were removed.</summary>
    public Task<int> PurgeOldNotificationsAsync(int limit, CancellationToken cancellationToken);

    /// <summary>Deletes up to <paramref name="limit"/> finished (fired, skipped, or cancelled) triggers older than 30 days. Returns how many were removed.</summary>
    public Task<int> PurgeFinishedTriggersAsync(int limit, CancellationToken cancellationToken);
}
