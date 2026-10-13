using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workspaces;

namespace Nix.Abstractions;

/// <summary>Stores the caller's own workspace arrangement with a compare-and-swap revision.</summary>
public interface IWorkspaceArrangementStore
{
    /// <summary>Reads only the current owner's arrangement.</summary>
    public ValueTask<WorkspaceArrangement?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Writes only if the expected revision is still current; zero means absent.</summary>
    public Task<bool> SaveAsync(WorkspaceArrangement arrangement, long expectedRevision, CancellationToken cancellationToken);
}
