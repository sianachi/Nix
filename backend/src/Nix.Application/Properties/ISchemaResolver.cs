using Nix.Core.Items;
using Nix.Core.Properties;

namespace Nix.Application.Properties;

/// <summary>
/// Resolves the property schema in force at a position in the tree.
/// </summary>
/// <remarks>
/// <para>
/// A port because the dependency direction requires one - the walk is a join against
/// <c>item_closure</c> and only Infrastructure may write that.
/// </para>
/// <para>
/// It is also the seam ADR-0007 §3 leaves open. Resolution is computed on read today; if a profile
/// ever shows the walk is not cheap enough, a materialised resolution can be written behind this
/// interface without a use case noticing. Nothing above it knows whether the answer was derived
/// or looked up.
/// </para>
/// </remarks>
public interface ISchemaResolver
{
    /// <summary>
    /// The effective schema for an item: every ancestor's declaration merged, nearest winning.
    /// </summary>
    /// <param name="itemId">The item whose position decides the answer.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>
    /// The merged schema, or <see cref="PropertySchema.Empty"/> when nothing in the chain declares
    /// one - and also when the item is not visible, because a schema is not a thing to leak.
    /// </returns>
    public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// The effective schema an item's children would carry.
    /// </summary>
    /// <param name="parentId">
    /// The prospective parent, or <see langword="null"/> for a workspace root.
    /// </param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The merged schema that applies inside that container.</returns>
    /// <remarks>
    /// Asked before an item exists, which is why it takes a parent rather than an item: creating a
    /// note has to validate its properties against the schema it is about to fall under, and there
    /// is no row yet to resolve from.
    /// </remarks>
    public ValueTask<PropertySchema> ResolveForChildrenAsync(
        ItemId? parentId,
        CancellationToken cancellationToken);
}
