using Nix.Domain.Items;

namespace Nix.Domain.Graph;

/// <summary>
/// One reference edge between two items, both of which the caller may read.
/// </summary>
/// <param name="SourceId">The item whose document holds the reference.</param>
/// <param name="TargetId">The item being referred to.</param>
/// <param name="Occurrences">How many times the source refers to the target. Always at least one.</param>
/// <remarks>
/// <para>
/// The occurrence count was left out at first, on the argument that a line drawn once does not
/// need to know it was earned three times. It is carried now because the drawing weights an edge
/// by it (owner decision, 2026-10-04). It discloses nothing new: an edge is returned only when the
/// caller may read the source, whose body states the same count, and a locked source draws no
/// outgoing edges at all.
/// </para>
/// <para>
/// <b>Both ends are nodes of the same reading.</b> An edge whose other end the caller may not read
/// is not returned at all - not returned with the far end blanked, which would disclose that
/// something is there.
/// </para>
/// </remarks>
public sealed record GraphLink(ItemId SourceId, ItemId TargetId, int Occurrences);
