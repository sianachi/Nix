namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Reading a workspace as a graph: what may be drawn, and what may be joined to what.
/// </summary>
/// <remarks>
/// <para>
/// <b>The permission filter is a predicate in the statement, not a pass over the results.</b> The
/// readable workspaces are resolved through <c>IPermissionResolver</c> before the query runs and
/// are never sent by the client. This is the same rule <see cref="SearchSql"/> states, and it is
/// stricter here for a reason worth writing down: a graph read is bulk disclosure. Every other item
/// read in the product starts from an identifier the caller already holds and returns one row; this
/// one returns the title and the parent of everything at once. Filtering after the fact would mean
/// the ceiling had already been spent on rows the caller may not see, so a workspace they share a
/// corner of could come back empty while the rest of it filled the limit - and the mistake would
/// surface as a drawing, which nobody diffs.
/// </para>
/// <para>
/// <b>Two predicates, not one.</b> Every statement here carries both
/// <c>workspace_id = @workspace_id</c> (which workspace was asked for) and
/// <c>workspace_id = ANY(@workspace_ids)</c> (which ones may be answered). While visibility is per
/// workspace the second is implied by a membership test the handler has already made, and the
/// duplication looks redundant; it is not, because the handler's test is a fact about the request
/// and the predicate is a fact about the rows. When access control entries make visibility per
/// item, the predicate is the line that grows and the handler does not move.
/// </para>
/// <para>
/// Index dependencies: <c>IX_item_tenant_id_workspace_id</c> for the node set,
/// <c>PK_item_link</c> and <c>ix_item_link_target</c> for the edges.
/// </para>
/// </remarks>
public static class GraphSql
{
    /// <summary>
    /// The readable nodes of one workspace and the reference edges between them, in one statement.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>One statement returning two row kinds, rather than two statements.</b> Nodes and links
    /// must describe the same instant. Read separately - even inside one transaction, which runs at
    /// read committed - the second statement could see an item the first did not, and the payload
    /// would carry an edge pointing at a node that is not in it. A client can only render that as a
    /// line into nothing. Discriminating on <c>row_kind</c> costs one integer column and removes
    /// the failure entirely.
    /// </para>
    /// <para>
    /// <b><c>visible</c> is referenced three times, which is what makes it correct.</b> Postgres
    /// inlines a CTE referenced once and materialises one referenced more than once, so the node
    /// set is computed exactly once and both the node arm and the edge arm are joined against that
    /// same set. Two copies of the same <c>SELECT ... LIMIT</c> would be two evaluations, and two
    /// evaluations of a limited, ordered set are only equal by luck.
    /// </para>
    /// <para>
    /// <b>The parent is self-joined rather than projected.</b> <c>item.parent_id</c> may name an
    /// item that is real, readable, and absent from this reading because the node ceiling was
    /// reached - and a parent identifier the payload cannot resolve is the same dangling reference
    /// the single-statement shape exists to prevent. The left join returns the parent only when it
    /// is itself a node, so a truncated graph is a smaller graph rather than a broken one.
    /// </para>
    /// <para>
    /// <b>An edge needs both ends.</b> <c>item_link</c> is joined to <c>visible</c> twice, so a
    /// reference to an item outside this workspace, outside the caller's entitlement, or outside
    /// the ceiling produces no row at all. It is not returned with the far end blanked: that would
    /// disclose that something is there, which for a graph is most of what there is to disclose.
    /// </para>
    /// <para>
    /// The ordering is stable so the same workspace draws the same way twice, and so the ceiling
    /// cuts the same items each time rather than a different subset per request. Nodes enter by
    /// <c>seq</c>, the workspace's own sibling order, so what survives a truncated read is the top
    /// of the tree rather than an arbitrary sample of it.
    /// </para>
    /// </remarks>
    public const string WorkspaceGraph = """
        WITH visible AS (
            SELECT item.id AS id,
                   item.parent_id AS parent_id,
                   item.type AS type,
                   item.properties ->> 'title' AS title
            FROM item
            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = @workspace_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS visibility_edge
                  LEFT JOIN LATERAL (
                      SELECT visibility_ancestor.template_id,
                             visibility_ancestor.lifecycle_state
                      FROM item AS visibility_ancestor
                      WHERE visibility_ancestor.tenant_id = @tenant_id
                        AND visibility_ancestor.id = visibility_edge.ancestor_id
                      LIMIT 1
                  ) AS stored_ancestor ON TRUE
                  WHERE visibility_edge.tenant_id = @tenant_id
                    AND visibility_edge.descendant_id = item.id
                    AND visibility_edge.depth > 0
                    AND (stored_ancestor.template_id IS NOT NULL
                         OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
                  OFFSET 0
              )
            ORDER BY item.seq, item.id
            LIMIT @node_limit
        ),
        edge AS (
            SELECT link.source_item_id AS source_id,
                   link.target_item_id AS target_id
            FROM item_link AS link
            JOIN visible AS source ON source.id = link.source_item_id
            JOIN visible AS target ON target.id = link.target_item_id
            WHERE link.tenant_id = @tenant_id
            ORDER BY link.source_item_id, link.target_item_id
            LIMIT @link_limit
        )
        SELECT 0 AS row_kind,
               node.id AS left_id,
               parent.id AS right_id,
               node.type AS type,
               node.title AS title
        FROM visible AS node
        LEFT JOIN visible AS parent
          ON parent.id = node.parent_id
        UNION ALL
        SELECT 1 AS row_kind,
               edge.source_id AS left_id,
               edge.target_id AS right_id,
               NULL::text AS type,
               NULL::text AS title
        FROM edge
        ORDER BY row_kind, left_id, right_id
        """;
}
