namespace Nix.Api.Features.Items;

/// <summary>
/// Moves an item to a new parent, optionally at a chosen position among its new siblings.
/// </summary>
/// <param name="ParentId">
/// The new parent, or <see langword="null"/> to move the item to the workspace root.
/// </param>
/// <param name="AfterId">
/// The sibling to place it immediately after, or <see langword="null"/> to place it first.
/// </param>
/// <remarks>
/// <para>
/// Ordering is expressed as "after this sibling" rather than as an index or a sequence number.
/// An index is a statement about a list the client last saw, which may have changed; a sibling
/// identifier is a statement about a relationship, which is still meaningful when it has.
/// </para>
/// <para>
/// A move whose new parent is the item itself or one of its own descendants is refused with
/// <c>items.move_would_create_cycle</c>. That is an expected outcome of a legitimate request -
/// drag a folder into its own child and this is what happens - so it is a typed failure with a
/// stable code, not an exception.
/// </para>
/// </remarks>
internal sealed record MoveItemRequest(Guid? ParentId, Guid? AfterId);
