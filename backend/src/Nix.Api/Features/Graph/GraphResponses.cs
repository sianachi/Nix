namespace Nix.Features.Graph;

/// <summary>One item, as a graph drawing needs it.</summary>
/// <param name="Id">The item.</param>
/// <param name="ParentId">
/// The item's parent, or <see langword="null"/> when it sits at the workspace root or when the
/// parent is not itself in <see cref="WorkspaceGraphResponse.Nodes"/>. A parent identifier is only
/// ever one this payload also carries, so a client never has to resolve an edge into nothing.
/// </param>
/// <param name="Type">How the item's own body is drawn.</param>
/// <param name="Title">
/// What it is called, or <see langword="null"/> when it has never been named. The client decides
/// what to draw for an unnamed node; the server does not invent a name for it.
/// </param>
internal sealed record GraphNodeResponse(Guid Id, Guid? ParentId, string Type, string? Title);

/// <summary>One reference edge between two nodes of this graph.</summary>
/// <param name="SourceId">The item whose document holds the reference.</param>
/// <param name="TargetId">The item being referred to.</param>
/// <remarks>
/// Both identifiers appear in <see cref="WorkspaceGraphResponse.Nodes"/>. An edge with an end the
/// caller may not read is absent rather than half-drawn.
/// </remarks>
internal sealed record GraphLinkResponse(Guid SourceId, Guid TargetId);

/// <summary>What a workspace graph read returned.</summary>
/// <param name="WorkspaceId">The workspace that was drawn, echoed so a client can discard a stale response.</param>
/// <param name="Nodes">The items the caller may read, in a stable order.</param>
/// <param name="Links">The reference edges between them.</param>
/// <param name="NodeLimit">The node ceiling that was applied.</param>
/// <param name="LinkLimit">The link ceiling that was applied.</param>
/// <param name="NodesTruncated">
/// Whether the node ceiling was reached, so the interface can say "showing the first two thousand"
/// rather than drawing a partial graph as though it were the whole one.
/// </param>
/// <param name="LinksTruncated">Whether the link ceiling was reached.</param>
/// <remarks>
/// <b>Truncation is in the payload because a graph cannot show it any other way.</b> A truncated
/// list looks short; a truncated graph looks like a graph. Somebody reading it would conclude that
/// two clusters are unconnected, which is a wrong answer rather than a missing one - so the flags
/// are part of the contract and not a header a client may ignore.
/// </remarks>
internal sealed record WorkspaceGraphResponse(
    Guid WorkspaceId,
    IReadOnlyList<GraphNodeResponse> Nodes,
    IReadOnlyList<GraphLinkResponse> Links,
    int NodeLimit,
    int LinkLimit,
    bool NodesTruncated,
    bool LinksTruncated);
