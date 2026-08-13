using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Bookmarks;

/// <summary>
/// One item on a shelf, as a list of them needs it: something to name, something to open, and when
/// it was kept.
/// </summary>
/// <param name="ItemId">The item.</param>
/// <param name="Title">What it is called, or <see langword="null"/> when it has never been named.</param>
/// <param name="Type">How the item's own body is drawn, so a list can show what kind of thing it is.</param>
/// <param name="WorkspaceId">
/// Which workspace it lives in. Carried because a shelf crosses workspaces and an item that cannot
/// say where it lives is a title with no context.
/// </param>
/// <param name="KeptAt">When it was kept.</param>
/// <remarks>
/// <para>
/// Read rather than stored. <see cref="Bookmark"/> is the row and holds only the reference; this is
/// what the row joins to the item to produce, so a rename shows up on the shelf immediately and
/// there is no second copy of a title to keep in step.
/// </para>
/// <para>
/// <b>A kept item exists only for an item the caller may still read.</b> Nothing constructs one to
/// stand in for an item they have lost access to: a placeholder saying "something you kept, that
/// you may not see" discloses that it is still there, which is most of what there is to disclose.
/// </para>
/// </remarks>
public sealed record KeptItem(
    ItemId ItemId,
    string? Title,
    string Type,
    WorkspaceId WorkspaceId,
    DateTimeOffset KeptAt);
