using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Links;

/// <summary>
/// One item's document refers to another item. The edge a backlink is read from.
/// </summary>
/// <remarks>
/// <para>
/// <b>Derived data.</b> Every edge is recomputable by replaying a document's update log,
/// materialising it and walking the result for reference nodes. Dropping the whole table is
/// always safe: it costs the backlinks panel until the documents are next snapshotted, and never
/// costs a document a word. Nothing may treat an edge as authoritative about a document's
/// contents - the update log is.
/// </para>
/// <para>
/// <b>Written by the collaboration service, read by Core.</b> The same split the content tables
/// carry, and for the same reason: extracting the edges means materialising the document, and
/// materialising a document needs a CRDT runtime Core does not have. Core's grant on this table
/// is <c>SELECT</c>.
/// </para>
/// <para>
/// <b>Item to item only.</b> A reference node can also point at a principal - that is what
/// <c>@</c> produces when it offers people - but a person is not a place a backlinks panel can
/// send you and has no document to list. Mentions of people are rendered and resolved without an
/// edge here; when they need a surface of their own they get a table of their own rather than a
/// nullable column on this one.
/// </para>
/// <para>
/// <b>One row per ordered pair, with a count.</b> A document that mentions another five times is
/// one backlink, not five, so the pair is the key. <see cref="Occurrences"/> is kept because it
/// is free at extraction time and is the difference between "mentioned in passing" and "the
/// subject of the paragraph" when this is eventually ranked.
/// </para>
/// </remarks>
public sealed class ItemLink
{
    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the item whose document holds the reference.</summary>
    public required ItemId SourceItemId { get; init; }

    /// <summary>Gets the item the reference points at.</summary>
    public required ItemId TargetItemId { get; init; }

    /// <summary>Gets how many times the source refers to the target.</summary>
    public required int Occurrences { get; init; }

    /// <summary>Gets the log position the edge was extracted from.</summary>
    /// <remarks>
    /// Two snapshots of the same document can be written concurrently by two processes holding it
    /// resident. Carrying the sequence lets the later extraction win and the earlier one be
    /// discarded, rather than whichever transaction happened to commit second.
    /// </remarks>
    public required long Seq { get; init; }
}
