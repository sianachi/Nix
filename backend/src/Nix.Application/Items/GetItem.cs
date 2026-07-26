using Nix.Application.Authorization;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Reads one item.</summary>
/// <remarks>
/// An item the caller may not read is reported as not found, never as forbidden: "you may not see
/// this" confirms the thing exists, which is how an outsider enumerates a workspace one identifier
/// at a time. Row-level security makes the two indistinguishable here by construction - an
/// invisible row simply is not returned. Row-level security answers the tenant question; the
/// permission resolver answers the workspace one, and both must agree before a row is returned.
/// </remarks>
public sealed class GetItem
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="GetItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public GetItem(IItemTree tree, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);

        _tree = tree;
        _permissions = permissions;
    }

    /// <summary>Reads the item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The item, or why it could not be read.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var mayRead = await _permissions
            .CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);

        return mayRead
            ? Result.Success(item)
            : Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
    }
}
