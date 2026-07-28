using Nix.Domain.Tenancy;

namespace Nix.Domain.Content;

/// <summary>
/// A materialisation of a document's log up to a point, so opening it does not mean replaying its
/// whole history.
/// </summary>
/// <remarks>
/// <para>
/// <b>Derived data.</b> Every snapshot is recomputable by replaying <see cref="ContentUpdate"/> from
/// the beginning, and dropping the whole table is always safe. Nothing may treat a snapshot as
/// authoritative: a reader loads the most recent one and then applies the updates after it, so a
/// missing or stale snapshot costs time and never correctness.
/// </para>
/// <para>
/// Three representations, for three different readers. <see cref="YjsState"/> is what an editor
/// resumes from. <see cref="ProseMirrorJson"/> is the structured document, for anything that wants
/// to read the content without a CRDT runtime - export, a future API consumer. <see cref="Plaintext"/>
/// is the flattened text that search will index, extracted here because this is the one place the
/// document is already materialised.
/// </para>
/// </remarks>
public sealed class ContentSnapshot
{
    /// <summary>Gets the document this snapshot materialises.</summary>
    public required ContentDocId DocId { get; init; }

    /// <summary>Gets the log position this snapshot includes up to, inclusive.</summary>
    public required long Seq { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the encoded CRDT state an editor resumes from.</summary>
    public required ReadOnlyMemory<byte> YjsState { get; init; }

    /// <summary>Gets the structured document, for readers with no CRDT runtime.</summary>
    public string? ProseMirrorJson { get; init; }

    /// <summary>Gets the flattened text, for the search index.</summary>
    public string? Plaintext { get; init; }

    /// <summary>Gets when the snapshot was taken.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}
