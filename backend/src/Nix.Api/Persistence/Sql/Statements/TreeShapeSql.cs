namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Questions about the shape of the tree, as opposed to its contents.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than LINQ, per the data-access rule, and here for a measured reason rather
/// than a stylistic one. The obvious LINQ spelling - select the distinct parent ids of every child
/// whose parent is in this page - reads <b>every child of every parent</b> and then deduplicates.
/// On a 50,000-item workspace that is 12,500 rows and 618 buffers to answer a question about 50
/// parents, and it gets worse in proportion to how full the containers are.
/// </para>
/// <para>
/// The statement below asks each parent whether it has <i>any</i> child and stops at the first one,
/// so its cost scales with the size of the page rather than with the size of the tree. Same data,
/// same index. Measured on the same 50,000-item workspace:
/// </para>
/// <code>
/// Nested Loop Semi Join (actual time=2.849..2.912 rows=50 loops=1)
///   -&gt;  Function Scan on unnest p (actual rows=50 loops=1)
///   -&gt;  Index Scan using "IX_item_workspace_id_parent_id_seq" on item c
///         (actual time=0.005..0.005 rows=1 loops=50)
///         Index Cond: ((workspace_id = $1) AND (parent_id = p.id))
///         Filter: (lifecycle_state = 'active')
///         Buffers: shared hit=200
/// Execution Time: 3.137 ms
/// </code>
/// <para>
/// <c>rows=1 loops=50</c> is the whole point: one row read per parent, not one per child. The
/// distinct-based version reported <c>rows=12500</c> for the identical answer.
/// </para>
/// <para>
/// Tenant-parameterised even though row-level security would filter anyway - defence in depth as
/// the security model requires, and what lets the planner use an index condition instead of
/// evaluating the policy per row.
/// </para>
/// </remarks>
public static class TreeShapeSql
{
    /// <summary>
    /// Of the given items, which have at least one child that is not deleted.
    /// </summary>
    /// <remarks>
    /// Returns only the ones that do; an item with no children is absent rather than false, so the
    /// result is the size of the answer rather than the size of the question.
    /// </remarks>
    public const string ParentsWithChildren = """
        SELECT p.id
        FROM unnest(@parent_ids) AS p(id)
        WHERE EXISTS (
            SELECT 1
            FROM item c
            WHERE c.tenant_id = @tenant_id
              AND c.workspace_id = @workspace_id
              AND c.parent_id = p.id
              AND c.lifecycle_state = 'active'
              AND c.template_id IS NULL)
        """;
}
