using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Serialises writes under one finance root for the rest of the transaction.</summary>
/// <remarks>
/// Two quick-adds, or a post-scheduled beside a month close, read the same children and decide
/// what to create from what they saw; without this, both could post the same direct debit. One
/// implementation, an advisory lock on the root's identifier, for the same reason the habit lock
/// has one: it is a statement about Postgres transactions, and a fake would test nothing.
/// </remarks>
public interface IFinanceLock
{
    /// <summary>Serialises changes to ancestry in a workspace with finance root operations.</summary>
    public ValueTask AcquireWorkspaceTopologyAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    public ValueTask AcquireAsync(ItemId rootId, CancellationToken cancellationToken);
}
