using Nix.Domain.Tenancy;

namespace Nix.Domain.Items;

/// <summary>
/// As much of an item as a list of them needs: what it is called, what kind it is, and where it
/// lives.
/// </summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="Type">How its own body is drawn.</param>
/// <param name="Title">What it is called, or <see langword="null"/> when it has never been named.</param>
/// <param name="ParentId">
/// The item it sits under, or <see langword="null"/> when it is a workspace root. Carried so a
/// picker can rank "beside the note being edited" above "somewhere else in the tenant" without a
/// second read per candidate.
/// </param>
/// <param name="UpdatedAt">When the item itself was last modified, so recency can break a tie.</param>
/// <remarks>
/// <para>
/// A projection, not an entity. Search results, a reference picker's candidates and a resolved
/// link all want the same six fields and none of them wants the property bag, the schema, the
/// view definitions or the lifecycle columns that <see cref="Item"/> carries - which on a page of
/// fifty results is six columns read instead of fourteen, and no JSON parsed at all.
/// </para>
/// <para>
/// <b>Neither added field discloses anything the item read does not already.</b> The parent
/// identifier is the same value <c>GET /api/v1/items/{id}</c> returns for an item the caller may
/// read, and a parent always shares its child's workspace - create and move both refuse a parent
/// from another one - so it never names an item in a workspace outside the caller's set. Every
/// statement that builds a digest also refuses an item with a deleted or template ancestor, so the
/// parent it names is itself active. An item under a locked ancestor is no exception: its envelope,
/// parent included, is already served by the item read and drawn by the workspace graph (a lock
/// withholds bodies, children listings and views, not descendants' envelopes), so naming the parent
/// here adds nothing a reader of that item could not already learn. The modification time is
/// likewise on the item read, including for a locked item: a lock withholds the body, not the
/// envelope. It moves with envelope writes and with each body flush batch (<c>TouchItem</c>), never
/// per keystroke.
/// </para>
/// <para>
/// Graph nodes and other projections stay separate on purpose: <c>GraphNode</c> needs a parent
/// that is itself in the payload, which is a different promise from this one.
/// </para>
/// <para>
/// <b>A digest exists only for an item the caller may read.</b> Nothing constructs one to say "and
/// this one you may not see": an unreadable item is absent from the list, because a placeholder is
/// how the existence of a thing leaks even when its contents do not.
/// </para>
/// </remarks>
public sealed record ItemDigest(
    ItemId Id,
    WorkspaceId WorkspaceId,
    string Type,
    string? Title,
    ItemId? ParentId,
    DateTimeOffset UpdatedAt);
