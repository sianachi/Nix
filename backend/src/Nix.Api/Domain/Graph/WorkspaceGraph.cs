namespace Nix.Domain.Graph;

/// <summary>
/// What draws a workspace's graph: the items the caller may read, and the reference edges between
/// them.
/// </summary>
/// <param name="Nodes">The readable items, in a stable order.</param>
/// <param name="Links">The reference edges whose two ends are both in <paramref name="Nodes"/>.</param>
/// <remarks>
/// <para>
/// <b>One value rather than two reads.</b> Nodes and links are read together, in one statement, so
/// they describe one instant. Fetched separately they would be two snapshots, and the second could
/// carry an edge whose node the first did not - which a client can only render as a line into
/// nothing, or crash on.
/// </para>
/// <para>
/// Whether either list was cut short is not recorded here. The ceilings are a property of the use
/// case, not of the graph, and a projection that carried its own truncation flag could be built
/// with the flag set wrongly. The handler compares the counts against the ceilings it applied.
/// </para>
/// </remarks>
public sealed record WorkspaceGraph(IReadOnlyList<GraphNode> Nodes, IReadOnlyList<GraphLink> Links)
{
    /// <summary>An empty graph, for a workspace with nothing readable in it.</summary>
    public static WorkspaceGraph Empty { get; } = new([], []);
}
