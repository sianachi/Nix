using Nix.Domain.Graph;

namespace Nix.Features.Graph;

/// <summary>
/// Turns the domain's graph projections into the shapes this feature publishes.
/// </summary>
/// <remarks>
/// Deliberately dull: no defaulting, no formatting, no "Untitled" invented for a node that has
/// never been named. A name a person did not choose is copy, and copy belongs where it can be
/// translated.
/// </remarks>
internal static class GraphMapping
{
    /// <summary>Maps the nodes, preserving order.</summary>
    /// <param name="nodes">The projections.</param>
    /// <returns>The published shapes.</returns>
    internal static IReadOnlyList<GraphNodeResponse> ToNodeResponses(IReadOnlyList<GraphNode> nodes)
    {
        ArgumentNullException.ThrowIfNull(nodes);

        var responses = new List<GraphNodeResponse>(nodes.Count);
        foreach (var node in nodes)
        {
            responses.Add(new GraphNodeResponse(
                node.Id.Value,
                node.ParentId?.Value,
                node.Type,
                node.Title));
        }

        return responses;
    }

    /// <summary>Maps the links, preserving order.</summary>
    /// <param name="links">The projections.</param>
    /// <returns>The published shapes.</returns>
    internal static IReadOnlyList<GraphLinkResponse> ToLinkResponses(IReadOnlyList<GraphLink> links)
    {
        ArgumentNullException.ThrowIfNull(links);

        var responses = new List<GraphLinkResponse>(links.Count);
        foreach (var link in links)
        {
            responses.Add(new GraphLinkResponse(link.SourceId.Value, link.TargetId.Value));
        }

        return responses;
    }
}
