using Nix.Abstractions;
using Nix.Domain.Graph;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Graph;

/// <summary>
/// Reads a workspace's nodes and reference edges in one statement, filtered by what the caller may
/// see while the statement runs.
/// </summary>
/// <remarks>
/// <para>
/// The readable workspaces arrive as an array parameter, so the planner evaluates the permission
/// predicate beside the tenant one. Nothing here resolves permissions for itself: a second
/// authorization path is the one that eventually disagrees with the first.
/// </para>
/// <para>
/// Results are materialised rather than streamed, because a graph is drawn all at once and the
/// caller has nothing to do with a partial one. The bound is the pair of ceilings the handler
/// applies, which is what keeps the materialisation a fixed cost rather than a workspace-sized one.
/// </para>
/// </remarks>
public sealed class WorkspaceGraphReader : IWorkspaceGraph
{
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes a new instance of the <see cref="WorkspaceGraphReader"/> class.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="session">The tenant this request runs as.</param>
    public WorkspaceGraphReader(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _sql = sql;
        _session = session;
    }

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A graph is read on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<WorkspaceGraph> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int nodeLimit,
        int linkLimit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(nodeLimit);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(linkLimit);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who may read nowhere draws nothing. Returning early keeps that a fact
            // about their membership rather than a round trip that was always going to return no
            // rows.
            return WorkspaceGraph.Empty;
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = _sql.QueryAsync<GraphRow, GraphRowMapper>(
            GraphSql.WorkspaceGraph,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                new NpgsqlParameter("node_limit", NpgsqlDbType.Integer) { Value = nodeLimit },
                new NpgsqlParameter("link_limit", NpgsqlDbType.Integer) { Value = linkLimit },
            ],
            cancellationToken);

        // Not sized to the ceilings. Pre-allocating for two thousand nodes would cost sixteen
        // kilobytes on every read of a workspace holding nine items, and the ceilings are a bound
        // on the worst case rather than a description of the ordinary one. Growth doubles into
        // arrays that stay well inside the 85 KB budget at both ceilings.
        var nodes = new List<GraphNode>();
        var links = new List<GraphLink>();

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (row.Kind == GraphRowKind.Node)
            {
                // The type column is NOT NULL and the node arm projects it directly, so a null here
                // is a broken statement rather than an unnamed item. Defaulting it to an empty
                // string would put an item on screen with no body kind and nothing to explain it.
                nodes.Add(new GraphNode(
                    ItemId.From(row.Left),
                    row.Right is { } parent ? ItemId.From(parent) : null,
                    row.Type ?? throw new InvalidOperationException(
                        "A node row came back with no type. The column is NOT NULL, so the graph "
                        + "statement has been edited into returning rows it cannot describe."),
                    row.Title));
            }
            else
            {
                // A link row without a target would mean the statement's inner join matched a null,
                // which it cannot. Guarding rather than asserting would turn a broken statement
                // into a silently thinner graph.
                links.Add(new GraphLink(
                    ItemId.From(row.Left),
                    ItemId.From(row.Right ?? throw new InvalidOperationException(
                        "A link row came back with no target. The graph statement inner-joins both "
                        + "ends of every edge, so this is a statement that has been edited into "
                        + "returning rows it cannot describe."))));
            }
        }

        return new WorkspaceGraph(nodes, links);
    }

    /// <summary>Which of the two shapes a row of the graph statement carries.</summary>
    private enum GraphRowKind
    {
        /// <summary>An item: identifier, parent, type, title.</summary>
        Node = 0,

        /// <summary>A reference edge: source and target.</summary>
        Link = 1,
    }

    /// <summary>
    /// One row of the graph statement, before it is sorted into a node or a link.
    /// </summary>
    /// <remarks>
    /// A struct, so streaming a couple of thousand rows through the mapper allocates only the
    /// records that survive into the result.
    /// </remarks>
    private readonly record struct GraphRow(GraphRowKind Kind, Guid Left, Guid? Right, string? Type, string? Title);

    /// <summary>Reads the five columns both row kinds share.</summary>
    /// <remarks>
    /// A struct, so the query loop devirtualises. Columns are read left to right because the reader
    /// is opened with sequential access.
    /// </remarks>
    private readonly struct GraphRowMapper : INixRowMapper<GraphRow>
    {
        /// <inheritdoc />
        public GraphRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var kind = reader.GetInt32(0) == 0 ? GraphRowKind.Node : GraphRowKind.Link;
            var left = reader.GetGuid(1);
            var right = reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2);
            var type = reader.IsDBNull(3) ? null : reader.GetString(3);
            var title = reader.IsDBNull(4) ? null : reader.GetString(4);

            return new GraphRow(kind, left, right, type, title);
        }
    }
}
