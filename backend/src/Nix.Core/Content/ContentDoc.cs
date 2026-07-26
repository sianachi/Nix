using Nix.Core.Items;
using Nix.Core.Tenancy;

namespace Nix.Core.Content;

/// <summary>
/// The body of a native item: a conflict-free replicated document, stored as an append-only log of
/// updates with periodic materialised snapshots.
/// </summary>
/// <remarks>
/// <para>
/// One document per item, and the item is what permissions are resolved against - a document has no
/// access rules of its own. That is why this row carries the item rather than the other way round:
/// there is exactly one place to ask "may this person read this", and it is the item.
/// </para>
/// <para>
/// <see cref="SchemaVersion"/> pins the document schema the content was written against. Updates
/// carrying a different version are refused rather than merged: a CRDT will happily combine two
/// documents that disagree about what a node means, and the result is one that neither version can
/// render.
/// </para>
/// </remarks>
public sealed class ContentDoc
{
    /// <summary>Gets the document's identifier.</summary>
    public required ContentDocId Id { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the item whose body this is.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the workspace the item belongs to.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the document schema version this content was written against.</summary>
    public required int SchemaVersion { get; init; }

    /// <summary>
    /// Gets the sequence of the most recent update.
    /// </summary>
    /// <remarks>
    /// Maintained alongside the log so a reader can ask "is there anything after what I have"
    /// without scanning it, and so an append can allocate the next sequence in one statement.
    /// </remarks>
    public required long HeadSeq { get; init; }

    /// <summary>Gets when the document was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}
