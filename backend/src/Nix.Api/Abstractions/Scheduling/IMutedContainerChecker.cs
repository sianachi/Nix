namespace Nix.Abstractions.Scheduling;

/// <summary>
/// Whether an item sits under one of a principal's muted containers, at fire time.
/// </summary>
/// <remarks>
/// Ordinary, RLS-scoped - unlike <see cref="IReminderCandidateFinder"/>, this runs inside the
/// session <see cref="Nix.Persistence.Scheduling.ScheduleDispatcher"/> already scoped to the
/// trigger's own tenant, workspace and principal before calling <c>FireAsync</c>, so no SECURITY
/// DEFINER elevation is needed: the closure rows for one recipient's own workspace are exactly
/// what row security already lets that session see.
/// </remarks>
public interface IMutedContainerChecker
{
    /// <summary>
    /// Whether <paramref name="itemId"/> or any of its ancestors is one of
    /// <paramref name="mutedContainerIds"/>.
    /// </summary>
    /// <param name="itemId">The item a reminder is about.</param>
    /// <param name="mutedContainerIds">The principal's currently muted containers.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    public Task<bool> IsMutedAsync(
        Guid itemId,
        IReadOnlyList<Guid> mutedContainerIds,
        CancellationToken cancellationToken);
}
