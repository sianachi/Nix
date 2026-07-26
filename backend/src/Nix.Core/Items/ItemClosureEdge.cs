using Nix.Core.Tenancy;

namespace Nix.Core.Items;

/// <summary>
/// One ancestor-to-descendant edge of the item tree, including each item's zero-depth edge to
/// itself.
/// </summary>
/// <remarks>
/// <para>
/// Derived data: every row here is recomputable from <see cref="Item.ParentId"/> alone, and the
/// tree goal's property test asserts exactly that by rebuilding the table from scratch and
/// comparing. Dropping and rebuilding it is always safe; treating it as a source of truth never
/// is.
/// </para>
/// <para>
/// It exists so that "every ancestor of this item" and "every descendant of that folder" are index
/// range scans instead of recursive walks - which is what makes permission resolution a single
/// join rather than a loop over the path to the root.
/// </para>
/// </remarks>
public sealed class ItemClosureEdge
{
    /// <summary>Gets the descendant end of the edge.</summary>
    public required ItemId DescendantId { get; init; }

    /// <summary>Gets the ancestor end of the edge.</summary>
    public required ItemId AncestorId { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the workspace both ends belong to.
    /// </summary>
    /// <remarks>
    /// <b>Denormalized from the item, and never an authorization filter source.</b> Nothing
    /// constrains it to agree with <see cref="Item.WorkspaceId"/>; the item's own column is the
    /// authority. See the same note on <c>AclEntry.WorkspaceId</c>.
    /// </remarks>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>
    /// Gets the number of edges between the two, zero for an item's edge to itself.
    /// </summary>
    /// <remarks>
    /// The tie-break in permission resolution: among matching entries the smallest depth is the
    /// nearest ancestor and wins.
    /// </remarks>
    public required int Depth { get; init; }
}
