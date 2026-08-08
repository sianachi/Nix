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
/// <remarks>
/// <para>
/// A projection, not an entity. Search results, a reference picker's candidates and a resolved
/// link all want the same four fields and none of them wants the property bag, the schema, the
/// view definitions or the lifecycle columns that <see cref="Item"/> carries - which on a page of
/// fifty results is four columns read instead of fourteen, and no JSON parsed at all.
/// </para>
/// <para>
/// <b>A digest exists only for an item the caller may read.</b> Nothing constructs one to say "and
/// this one you may not see": an unreadable item is absent from the list, because a placeholder is
/// how the existence of a thing leaks even when its contents do not.
/// </para>
/// </remarks>
public sealed record ItemDigest(ItemId Id, WorkspaceId WorkspaceId, string Type, string? Title);
