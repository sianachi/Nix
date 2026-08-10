using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Graph;

/// <summary>
/// What the graph statement must say, asserted against its text.
/// </summary>
/// <remarks>
/// <para>
/// Reading SQL with string assertions is normally a bad test: it restates the implementation and
/// fails on whitespace. It earns its place here because the property is a property of the text.
/// The predicate that keeps one workspace's titles out of another's graph either appears in the
/// statement or does not, and a statement missing it still compiles, still runs, still returns
/// rows, and is a breach. Two tenants against real Postgres prove the behaviour in
/// <c>Nix.Integration.Tests</c>; this proves the shape without a Docker daemon, which is the suite
/// a developer runs on every save.
/// </para>
/// <para>
/// Each assertion names the way the statement could be wrong, not the way it is written.
/// </para>
/// </remarks>
public sealed class GraphStatementTests
{
    [Fact]
    public void The_graph_statement_filters_nodes_by_the_workspaces_the_caller_may_read()
    {
        // Bound from IPermissionResolver, never from the request. Its absence is the whole breach.
        Assert.Contains(
            "item.workspace_id = ANY(@workspace_ids)",
            GraphSql.WorkspaceGraph,
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_graph_statement_also_pins_the_workspace_that_was_asked_for()
    {
        // Two predicates, not one: which workspace was requested, and which ones may be answered.
        Assert.Contains(
            "item.workspace_id = @workspace_id",
            GraphSql.WorkspaceGraph,
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_graph_statement_scopes_every_table_it_reads_to_one_tenant()
    {
        // Row-level security is the backstop and the predicate is the intent. Both tables are named
        // because a missing tenant predicate on the edge table would leak the existence of a link,
        // which is a fact about two documents.
        Assert.Contains("item.tenant_id = @tenant_id", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
        Assert.Contains("link.tenant_id = @tenant_id", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }

    [Fact]
    public void Both_ends_of_every_edge_are_joined_to_the_visible_node_set()
    {
        // An edge is disclosed only when the caller may read what is at each end. Joining one end
        // and projecting the other would publish the identifier of an item they cannot see - which
        // in a graph is most of what there is to publish.
        Assert.Contains(
            "JOIN visible AS source ON source.id = link.source_item_id",
            GraphSql.WorkspaceGraph,
            StringComparison.Ordinal);
        Assert.Contains(
            "JOIN visible AS target ON target.id = link.target_item_id",
            GraphSql.WorkspaceGraph,
            StringComparison.Ordinal);
    }

    [Fact]
    public void An_edge_is_joined_to_the_node_set_rather_than_left_joined_to_it()
    {
        // A left join here would return the edge with a null end instead of dropping it, and the
        // reader would have to decide what to do with half an edge. It has no honest option.
        Assert.DoesNotContain("LEFT JOIN visible AS source", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
        Assert.DoesNotContain("LEFT JOIN visible AS target", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }

    [Fact]
    public void Deleted_items_are_not_drawn()
    {
        Assert.Contains("item.lifecycle_state = 'active'", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }

    [Fact]
    public void Both_ceilings_are_bound_parameters_rather_than_literals()
    {
        // The ceilings live on the handler, are published in the contract, and are reported back in
        // the payload. A literal here would be a fourth copy, and the one nobody reads.
        Assert.Contains("LIMIT @node_limit", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
        Assert.Contains("LIMIT @link_limit", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }

    [Fact]
    public void Nodes_and_links_are_read_in_one_statement()
    {
        // Two statements would be two snapshots under read committed, and the second could carry an
        // edge whose node the first did not. The discriminator column is what makes one round trip
        // able to answer both.
        Assert.Contains("UNION ALL", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
        Assert.Contains("row_kind", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }

    [Fact]
    public void The_node_set_is_computed_once_and_shared_by_both_arms()
    {
        // Postgres materialises a CTE referenced more than once, so the nodes the edges are joined
        // against are the nodes that are returned. Two copies of the same limited, ordered SELECT
        // would be equal only by luck.
        Assert.Contains("WITH visible AS", GraphSql.WorkspaceGraph, StringComparison.Ordinal);
    }
}
