using Nix.Application.Authorization;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Marks an item deleted, leaving its subtree intact.</summary>
/// <remarks>
/// <para>
/// <b>Soft deletion is one flag on one row, never a cascade.</b> Descendants disappear from
/// listings because a listing walks down from a visible parent, not because anything rewrote them,
/// which is what makes restoring a single flip back rather than a reconstruction from a log. It is
/// also what makes deleting a folder of ten thousand notes cost the same as deleting one note.
/// </para>
/// <para>
/// Purging is a separate, retention-driven operation and is not reachable from here. An item this
/// use case has deleted is still stored, still counted against quota, and still restorable until
/// the retention window closes over it.
/// </para>
/// </remarks>
public sealed class DeleteItem
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="DeleteItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public DeleteItem(
        IItemTree tree,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);

        _tree = tree;
        _permissions = permissions;
        _session = session;
        _clock = clock;
    }

    /// <summary>Deletes the item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The deleted item's identifier, or why it could not be deleted.</returns>
    /// <remarks>
    /// Deleting an already-deleted item succeeds. The caller asked for a state, the state holds, and
    /// a client retrying after a dropped response should not be told its second attempt was wrong.
    /// </remarks>
    public async ValueTask<Result<ItemId>> ExecuteAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<ItemId>(
                ItemErrors.LifecycleConflict("A purged item cannot be deleted; it is already gone."));
        }

        if (item.LifecycleState == ItemLifecycleState.Deleted)
        {
            return Result.Success(itemId);
        }

        await _tree
            .SetLifecycleAsync(
                itemId,
                ItemLifecycleState.Deleted,
                context.PrincipalId,
                _clock.GetUtcNow(),
                cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(itemId);
    }
}
