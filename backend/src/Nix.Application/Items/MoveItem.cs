using Nix.Application.Authorization;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Moves an item to a new parent, at a chosen position among its new siblings.</summary>
/// <remarks>
/// <para>
/// The one operation that can corrupt the tree, so it is the one with the most checks. A move into
/// the item's own subtree would produce a cycle: a set of rows reachable only from each other, no
/// longer under any workspace root, invisible to every listing and impossible to delete through the
/// interface. The closure table makes that question a single indexed lookup rather than a walk, and
/// it is asked before anything is written.
/// </para>
/// <para>
/// Placement is expressed as "after this sibling" rather than as an index, because an index is a
/// claim about a list the client last saw and a sibling identifier is a claim about a relationship
/// that is still meaningful when the list has changed underneath it.
/// </para>
/// </remarks>
public sealed class MoveItem
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="MoveItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public MoveItem(
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

    /// <summary>Moves the item.</summary>
    /// <param name="itemId">The item to move.</param>
    /// <param name="newParentId">The new parent, or <see langword="null"/> for the workspace root.</param>
    /// <param name="afterId">
    /// The sibling to sit immediately after, or <see langword="null"/> to sit first.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The moved item, or why it could not be moved.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(
        ItemId itemId,
        ItemId? newParentId,
        ItemId? afterId,
        CancellationToken cancellationToken)
    {
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<Item>(ItemErrors.LifecycleConflict("A purged item cannot be moved."));
        }

        if (newParentId is { } destination)
        {
            var parent = await _tree.FindAsync(destination, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != item.WorkspaceId)
            {
                // Cross-workspace moves are not a move; they are a copy and a delete, with their
                // own permission questions on both ends. Refusing here keeps a single operation
                // from quietly becoming that.
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {destination} is visible in this workspace."));
            }

            if (parent.LifecycleState != ItemLifecycleState.Active)
            {
                return Result.Failure<Item>(
                    ItemErrors.LifecycleConflict("An item cannot be moved into a deleted parent."));
            }

            if (destination == itemId
                || await _tree.WouldCreateCycleAsync(itemId, destination, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(
                    ItemErrors.WouldCreateCycle(
                        $"Item {itemId} cannot be moved into itself or into one of its descendants."));
            }
        }

        if (afterId is { } anchor)
        {
            var sibling = await _tree.FindAsync(anchor, cancellationToken).ConfigureAwait(false);
            if (sibling is null || sibling.WorkspaceId != item.WorkspaceId)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {anchor} is visible."));
            }

            if (sibling.ParentId != newParentId || anchor == itemId)
            {
                // Placing something after a sibling that is not in the destination has no defined
                // meaning. Guessing one - appending, or ignoring the request - would put the item
                // somewhere the caller did not ask for, which is exactly what a drag-and-drop user
                // notices and nobody else does.
                return Result.Failure<Item>(
                    ItemErrors.SiblingNotInDestination(
                        $"Item {anchor} is not a child of the destination, so it cannot order the move."));
            }
        }

        var seq = await _tree
            .AllocateSiblingSequenceAsync(item.WorkspaceId, newParentId, itemId, afterId, cancellationToken)
            .ConfigureAwait(false);

        await _tree
            .ReparentAsync(itemId, newParentId, seq, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        // Re-read rather than patching the shape in memory: the closure rewrite and the row update
        // both went through the store, and inventing what the row now looks like is how a response
        // drifts from the row it claims to describe.
        var moved = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return moved is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the move."))
            : Result.Success(moved);
    }
}
