using Nix.Domain.Items;

namespace Nix.Domain.Graph;

/// <summary>
/// One reference edge between two items, both of which the caller may read.
/// </summary>
/// <param name="SourceId">The item whose document holds the reference.</param>
/// <param name="TargetId">The item being referred to.</param>
/// <remarks>
/// <para>
/// No occurrence count, unlike <see cref="Nix.Domain.Links.Backlink"/>. A backlinks panel orders by
/// it; a graph draws a line, and a line that is drawn once does not need to know it was earned
/// three times. Leaving it out also means the graph says nothing about how much one document
/// discusses another.
/// </para>
/// <para>
/// <b>Both ends are nodes of the same reading.</b> An edge whose other end the caller may not read
/// is not returned at all - not returned with the far end blanked, which would disclose that
/// something is there.
/// </para>
/// </remarks>
public sealed record GraphLink(ItemId SourceId, ItemId TargetId);
