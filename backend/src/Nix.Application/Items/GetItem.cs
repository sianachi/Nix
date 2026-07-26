using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>Reads one item.</summary>
/// <remarks>
/// An item the caller may not read is reported as not found, never as forbidden: "you may not see
/// this" confirms the thing exists, which is how an outsider enumerates a workspace one identifier
/// at a time. Row-level security makes the two indistinguishable here by construction - an
/// invisible row simply is not returned.
/// </remarks>
public sealed class GetItem
{
    private readonly IItemTree _tree;

    /// <summary>Initializes a new instance of the <see cref="GetItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    public GetItem(IItemTree tree)
    {
        ArgumentNullException.ThrowIfNull(tree);
        _tree = tree;
    }

    /// <summary>Reads the item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The item, or why it could not be read.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return item is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."))
            : Result.Success(item);
    }
}
