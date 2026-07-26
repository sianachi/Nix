using Nix.Core.Identity;
using Nix.Core.Tenancy;

namespace Nix.Core.Content;

/// <summary>
/// One conflict-free update to a document: the durable form of an edit.
/// </summary>
/// <remarks>
/// <para>
/// <b>This table is the source of truth for document content, and it is append-only.</b> A snapshot
/// is a materialisation of the log up to a point and can always be thrown away and rebuilt; the log
/// cannot. Nothing updates a row here and nothing deletes one outside a purge.
/// </para>
/// <para>
/// Append-only is what makes the merge safe. Updates commute and are idempotent, so it does not
/// matter in what order two clients' edits arrive, and a re-delivered update changes nothing. That
/// property is the entire reason concurrent editing works without a coordinating server, and it
/// survives only while the log is never rewritten.
/// </para>
/// <para>
/// <see cref="ClientId"/> identifies the browser session that produced the update, not the person -
/// one principal editing in two tabs produces two client ids, which is exactly the case that must
/// merge rather than conflict.
/// </para>
/// </remarks>
public sealed class ContentUpdate
{
    /// <summary>Gets the document this update belongs to.</summary>
    public required ContentDocId DocId { get; init; }

    /// <summary>
    /// Gets the update's position in the log.
    /// </summary>
    /// <remarks>
    /// Server-assigned and monotonic per document. It orders the log for catch-up - "give me
    /// everything after 42" - and carries no meaning for the merge itself, which is order
    /// independent.
    /// </remarks>
    public required long Seq { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the encoded update.
    /// </summary>
    /// <remarks>
    /// Opaque to Core, which stores and serves it without interpreting it. The collaboration
    /// service is the only thing that applies an update, because validating one means merging it
    /// and inspecting the result - which needs a CRDT runtime.
    /// </remarks>
    public required ReadOnlyMemory<byte> UpdateBytes { get; init; }

    /// <summary>Gets the principal whose edit this was.</summary>
    public required PrincipalId ActorId { get; init; }

    /// <summary>Gets the editing session that produced it.</summary>
    public required string ClientId { get; init; }

    /// <summary>Gets when it was recorded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}
