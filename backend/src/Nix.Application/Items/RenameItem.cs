using Nix.Application.Authorization;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Changes an item's display name.</summary>
/// <remarks>
/// The title is one of the item's properties rather than a column of its own, so a rename reads
/// the property bag, replaces one key and writes the whole bag back. Preserving the rest matters:
/// a rename must not silently drop properties a later goal added and this code knows nothing about.
/// </remarks>
public sealed class RenameItem
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="RenameItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public RenameItem(
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

    /// <summary>Renames the item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="title">The new display name.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The renamed item, or why it could not be renamed.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(
        ItemId itemId,
        string title,
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
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A purged item cannot be renamed."));
        }

        var now = _clock.GetUtcNow();
        var properties = ItemProperties.WithTitle(item.Properties, title);

        await _tree
            .UpdatePropertiesAsync(itemId, properties, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);

        // Re-read rather than constructing the updated shape here: the write went through the
        // store, and inventing what the row now looks like is how a response drifts from the row
        // it claims to describe.
        var renamed = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return renamed is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the rename."))
            : Result.Success(renamed);
    }
}
