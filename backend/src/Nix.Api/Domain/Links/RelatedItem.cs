using Nix.Domain.Items;

namespace Nix.Domain.Links;

/// <summary>
/// One item that the documents linking to an item also link to, and how many of them do.
/// </summary>
/// <param name="Item">The co-cited item.</param>
/// <param name="SharedSources">
/// How many readable, unlocked documents link to both it and the item being read.
/// </param>
/// <remarks>
/// <para>
/// The sources themselves are not carried. They were filtered by what the caller may read before
/// they were counted, but naming them is the backlinks panel's job; this is a ranking signal, and a
/// ranking signal that also listed its evidence would be a second, unbounded backlinks read.
/// </para>
/// <para>
/// A count of zero never appears: an item with no shared source is not related, and is absent.
/// </para>
/// </remarks>
public sealed record RelatedItem(ItemDigest Item, int SharedSources);
