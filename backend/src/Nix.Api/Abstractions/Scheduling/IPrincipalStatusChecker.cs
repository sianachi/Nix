using Nix.Domain.Identity;

namespace Nix.Abstractions.Scheduling;

/// <summary>
/// Whether a principal may still act, at fire time.
/// </summary>
/// <remarks>
/// A suspended or deprovisioned principal keeps their grants by design (suspension is meant to be
/// reversible without re-provisioning), so <see cref="IPermissionResolver"/> alone cannot tell a
/// reminder source that the recipient should no longer receive one - workspace membership survives
/// suspension. The ordinary request pipeline refuses a suspended or deprovisioned principal before
/// a handler ever runs; the dispatcher bypasses that pipeline entirely (there is no request), so
/// each source re-checks this explicitly, the same way it re-checks everything else at fire time.
/// </remarks>
public interface IPrincipalStatusChecker
{
    /// <summary>Whether <paramref name="principalId"/> is <see cref="PrincipalStatus.Active"/> right now.</summary>
    public Task<bool> IsActiveAsync(PrincipalId principalId, CancellationToken cancellationToken);
}
