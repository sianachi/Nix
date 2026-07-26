using Nix.Application.Authorization;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Returns a soft-deleted item to the active state.</summary>
/// <remarks>
/// <para>
/// The inverse of <see cref="DeleteItem"/>, and deliberately just as small: one flag on one row.
/// The subtree was never rewritten, so there is nothing to reconstruct.
/// </para>
/// <para>
/// <b>Restoring an item whose parent is still deleted succeeds, and the item stays out of sight.</b>
/// Visibility is derived by walking down from a visible root, so the item is active and its
/// ancestor is not. Refusing instead would be defensible, but it makes restoring a subtree an
/// ordering puzzle for the caller, and the honest interface answer is a view that says why the item
/// is not where the user expected it - not a refusal that leaves them nowhere.
/// </para>
/// </remarks>
public sealed class RestoreItem
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="RestoreItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public RestoreItem(
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

    /// <summary>Restores the item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The restored item, or why it could not be restored.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(ItemId itemId, CancellationToken cancellationToken)
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
            // The one lifecycle transition that is genuinely impossible: purging destroys the
            // content, so there is nothing to bring back and saying otherwise would be a lie.
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A purged item cannot be restored."));
        }

        if (item.LifecycleState == ItemLifecycleState.Active)
        {
            return Result.Success(item);
        }

        var now = _clock.GetUtcNow();
        await _tree
            .SetLifecycleAsync(itemId, ItemLifecycleState.Active, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);

        var restored = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return restored is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the restore."))
            : Result.Success(restored);
    }
}
