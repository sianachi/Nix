using Nix.Core.Identity;
using Nix.Core.Tenancy;

namespace Nix.Core.Items;

/// <summary>
/// The universal object. One parent, exactly one workspace, properties validated against an
/// inherited schema, and children of its own if anything has been put inside it.
/// </summary>
/// <remarks>
/// <para>
/// One table for every kind of thing is the decision the rest of the product rests on. It is why
/// anything can hold anything, why a task can be given a document body, and why permissions,
/// search, and the tree have one implementation each rather than one per type. <see cref="Type"/>
/// discriminates behaviour; it does not discriminate storage.
/// </para>
/// <para>
/// Content bodies (<c>content_doc</c>) and file bodies (<c>file_version</c>) live in their own
/// tables. Property schemas and views are columns here, per ADR-0006. Saved cross-folder queries
/// (<c>query</c>) arrive with the phase that builds them, in that phase's own migration.
/// </para>
/// </remarks>
public sealed class Item
{
    /// <summary>Gets the item's identifier.</summary>
    public required ItemId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace the item lives in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>
    /// Gets the item's kind, which says how its own body is drawn - a note's prose, a canvas's
    /// scene.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Text rather than an enumeration because the set is open by design: adding a kind should be a
    /// feature, not a migration.
    /// </para>
    /// <para>
    /// <b>It says nothing about what an item may contain.</b> Every item can hold children, declare
    /// a property schema and offer views, whatever its kind. "Folder" used to be a kind here and
    /// was never a body at all - only a claim about containment that the schema never made.
    /// </para>
    /// </remarks>
    public required string Type { get; init; }

    /// <summary>
    /// Gets the parent item, or <see langword="null"/> for a workspace root.
    /// </summary>
    /// <remarks>
    /// Single-parent by construction. The closure table derives ancestry from this column and is
    /// rebuildable from it, so this is the durable fact and the closure is the index.
    /// </remarks>
    public ItemId? ParentId { get; init; }

    /// <summary>
    /// Gets the item's position among its siblings.
    /// </summary>
    /// <remarks>
    /// Sparse rather than dense: gaps are left between neighbours so an insertion writes one row
    /// instead of renumbering the whole sibling set.
    /// </remarks>
    public required long Seq { get; init; }

    /// <summary>
    /// Gets the item's properties as a JSON object, or <see langword="null"/> when it has none.
    /// </summary>
    /// <remarks>
    /// Held as a JSON string rather than a parsed document: nothing in this phase reads it, and
    /// keeping it opaque avoids paying for a parse on every item read. The goal that introduces
    /// property schemas owns the typed representation and the validation on write.
    /// </remarks>
    public string? Properties { get; init; }

    /// <summary>
    /// Gets the property schema this item declares for itself and its descendants, as a JSON
    /// object, or <see langword="null"/> when it declares none.
    /// </summary>
    /// <remarks>
    /// Held as a JSON string for the same reason <see cref="Properties"/> is: most reads of an
    /// item do not want it, and parsing on every one would be paid by every listing.
    /// <c>Nix.Core.Properties.PropertySchemaJson</c> owns the typed representation, and is the
    /// only thing that should read this.
    /// </remarks>
    public string? Schema { get; init; }

    /// <summary>
    /// Gets the views this container offers, as a JSON object, or <see langword="null"/> when it
    /// offers none.
    /// </summary>
    /// <remarks>
    /// A view is a way of rendering this item's children, stored on the container because that is
    /// what it belongs to - "board" is something a folder can be shown as, not a place in the
    /// application. <c>Nix.Core.Views.ViewDefinitionsJson</c> owns the typed representation.
    /// </remarks>
    public string? Views { get; init; }

    /// <summary>Gets where the item sits in the deletion lifecycle.</summary>
    public required ItemLifecycleState LifecycleState { get; init; }

    /// <summary>
    /// Gets when a soft-deleted item becomes eligible for purge, or <see langword="null"/> if it
    /// is not scheduled. Legal hold blocks the transition regardless of this value.
    /// </summary>
    public DateTimeOffset? PurgeAfter { get; init; }

    /// <summary>Gets who created the item.</summary>
    public required PrincipalId CreatedBy { get; init; }

    /// <summary>Gets who last modified it.</summary>
    public required PrincipalId LastModifiedBy { get; init; }

    /// <summary>Gets when the item was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when the item was last modified.</summary>
    public required DateTimeOffset LastModifiedAt { get; init; }
}
