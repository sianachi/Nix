using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Backs <see cref="IPrincipalStatusChecker"/> with an ordinary, RLS-scoped read of
/// <c>principal</c> - the same session <see cref="ScheduleDispatcher"/> has already scoped to the
/// trigger's own tenant and principal before <c>FireAsync</c> runs.
/// </summary>
public sealed class PrincipalStatusChecker(NixDbContext database) : IPrincipalStatusChecker
{
    public async Task<bool> IsActiveAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var status = await database.Set<Principal>()
            .AsNoTracking()
            .Where(principal => principal.Id == principalId)
            .Select(principal => (PrincipalStatus?)principal.Status)
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);

        // A principal row that no longer exists at all is not "active" either - the same
        // fail-closed answer a deprovisioned one gets.
        return status == PrincipalStatus.Active;
    }
}
