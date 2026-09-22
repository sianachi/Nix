using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Serialises generic item mutations that could affect a finance root or its records.</summary>
public interface IFinanceMutationGuard
{
    /// <summary>Locks every affected root, re-reads finance ancestry, and refuses closed data.</summary>
    public ValueTask<NixError?> CheckAsync(
        WorkspaceId workspaceId,
        ItemId itemId,
        ItemId? destinationParentId,
        bool includeSubtree,
        CancellationToken cancellationToken,
        bool allowOpenTransaction = false);
}
