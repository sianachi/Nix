using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Links;

/// <summary>
/// The searchable text of one item's document, one row per item.
/// </summary>
/// <remarks>
/// <para>
/// <b>Derived data.</b> Recomputable by replaying the update log and materialising it, the same
/// way <c>content_snapshot.plaintext</c> is - this is that text, indexed. Dropping the table costs
/// body search until documents are next snapshotted and costs nothing durable.
/// </para>
/// <para>
/// <b>One row per item, not one per snapshot.</b> <c>content_snapshot</c> holds many rows for a
/// document - one every few hundred updates, one every few minutes, one on eviction - so a search
/// vector living there would index text the document no longer contains and match on it. There is
/// no static predicate that could partial-index the history away, because "the newest snapshot"
/// is not a property of a row. Upserting one row per item is both correct and smaller.
/// </para>
/// <para>
/// <b>The vector itself is not mapped here.</b> <c>body_vector</c> is a <c>tsvector</c>, a type
/// only Npgsql knows about, and the domain carries no infrastructure. It is created by the
/// migration's hand-written half, written by the collaboration service, and read by the one
/// hand-written statement in <c>SearchSql</c> that matches against it. Nothing needs it as a .NET
/// value, so nothing maps it.
/// </para>
/// <para>
/// <b>No title here.</b> A title lives on the item, in <c>properties</c>, and is owned by Core.
/// Copying it into this row would give the same fact two writers and let a rename go unreflected
/// in search; the search statement joins <c>item</c> instead, so a rename is visible to the next
/// query with no reindex at all.
/// </para>
/// </remarks>
public sealed class ItemSearchEntry
{
    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the item whose document this indexes.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the log position the text was materialised from.</summary>
    /// <remarks>Orders two concurrent extractions, exactly as <see cref="ItemLink.Seq"/> does.</remarks>
    public required long Seq { get; init; }

    /// <summary>Gets when the entry was last written.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
