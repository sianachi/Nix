using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Properties;

/// <summary>
/// What the fold statements must say, asserted against their text.
/// </summary>
/// <remarks>
/// The argument <c>QueryStatementTests</c> makes: the predicate that keeps one tenant's rows out of
/// another's answer either appears in the statement or does not, and its absence still compiles,
/// still runs, and is a breach. Two tenants against real Postgres prove the behaviour in
/// <c>Nix.Integration.Tests</c>; this proves the shape without a Docker daemon.
/// </remarks>
public sealed class RollupStatementTests
{
    [Fact]
    public void The_fold_reads_one_tenant_and_one_workspace()
    {
        var sql = RollupSql.AggregateChildProperties;

        Assert.Contains("c.tenant_id = @tenant_id", sql, StringComparison.Ordinal);
        Assert.Contains("c.workspace_id = @workspace_id", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_fold_counts_only_what_the_list_beside_it_would_show()
    {
        // A rollup that counted a deleted child, or a template's, would disagree with the list
        // drawn next to it - and the person would have no way to find the difference.
        var sql = RollupSql.AggregateChildProperties;

        Assert.Contains("c.lifecycle_state = 'active'", sql, StringComparison.Ordinal);
        Assert.Contains("c.template_id IS NULL", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_fold_takes_the_parents_and_the_keys_as_arrays_so_a_page_is_one_query()
    {
        var sql = RollupSql.AggregateChildProperties;

        Assert.Contains("unnest(@parent_ids)", sql, StringComparison.Ordinal);
        Assert.Contains("unnest(@keys)", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_fold_is_driven_by_the_parents_rather_than_joined_to_them()
    {
        // The shape the measurement chose. A plain join let the planner hash the page's parents and
        // scan the whole workspace - a plan whose cost grows with the workspace instead of with the
        // page. A lateral carrying an aggregate cannot be hoisted into a hash join, so the parents
        // drive. RollupPlanEvidenceTests holds the plan; this holds the shape it depends on.
        Assert.Contains("CROSS JOIN LATERAL", RollupSql.AggregateChildProperties, StringComparison.Ordinal);
        Assert.Contains("c.parent_id = p.id", RollupSql.AggregateChildProperties, StringComparison.Ordinal);
    }

    [Fact]
    public void The_fold_checks_a_value_kind_before_casting_it()
    {
        // A property bag is client-influenced data. An unguarded numeric cast over a bag where one
        // row holds the text "soon" fails the whole statement, so one bad value would cost every
        // rollup on the page.
        var sql = RollupSql.AggregateChildProperties;

        Assert.Contains("jsonb_typeof(c.properties -> k.key) = 'number'", sql, StringComparison.Ordinal);
        Assert.Contains("jsonb_typeof(c.properties -> k.key) = 'boolean'", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_fold_does_not_use_the_containment_operator()
    {
        // `?` is the one jsonb operator whose spelling collides with a parameter placeholder in
        // several drivers. A statement that works until somebody changes how parameters are bound
        // is a statement waiting to break for a reason nobody would look for here.
        Assert.DoesNotContain('?', RollupSql.AggregateChildProperties);
    }

    [Fact]
    public void The_bucketing_reads_one_tenant_one_workspace_and_one_parent()
    {
        var sql = RollupSql.BucketChildrenByProperty;

        Assert.Contains("c.tenant_id = @tenant_id", sql, StringComparison.Ordinal);
        Assert.Contains("c.workspace_id = @workspace_id", sql, StringComparison.Ordinal);
        Assert.Contains("c.parent_id = @parent_id", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_bucketing_counts_only_what_the_list_beside_it_would_show()
    {
        var sql = RollupSql.BucketChildrenByProperty;

        Assert.Contains("c.lifecycle_state = 'active'", sql, StringComparison.Ordinal);
        Assert.Contains("c.template_id IS NULL", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_bucketing_is_bounded_and_says_what_it_left_out()
    {
        // A bounded read that only returned its buckets would be a picture of the top few
        // presented as a picture of all of them.
        var sql = RollupSql.BucketChildrenByProperty;

        Assert.Contains("LIMIT @limit", sql, StringComparison.Ordinal);
        Assert.Contains("count(*) OVER () AS buckets", sql, StringComparison.Ordinal);
        Assert.Contains("sum(count(*)) OVER () AS all_children", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_bucketing_keeps_the_children_that_have_no_value_as_their_own_bucket()
    {
        // Unset is a real bucket and often a large one; hiding it would misreport every proportion
        // drawn beside it.
        Assert.Contains(
            "GROUP BY c.properties ->> @group_key",
            RollupSql.BucketChildrenByProperty,
            StringComparison.Ordinal);
        Assert.Contains(
            "NULLS LAST",
            RollupSql.BucketChildrenByProperty,
            StringComparison.Ordinal);
    }
}
