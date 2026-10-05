using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Persistence;

/// <summary>
/// Security and plan-shape invariants carried by the point-visibility statement itself.
/// </summary>
/// <remarks>
/// The integration suite proves these predicates against Postgres and captures the executed plan.
/// These narrow text assertions keep the fail-closed and optimization-fence clauses visible in
/// the daemon-free suite, because their removal still compiles and can look correct on shallow
/// fixture data.
/// </remarks>
public sealed class ItemVisibilityStatementTests
{
    [Fact]
    public void The_subject_must_be_an_active_ordinary_item_in_the_current_tenant()
    {
        Assert.Contains(
            "subject.tenant_id = @tenant_id",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
        Assert.Contains(
            "subject.template_id IS NULL",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
        Assert.Contains(
            "subject.lifecycle_state = 'active'",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Only_proper_ancestors_are_checked_after_the_subject_is_proven_active()
    {
        Assert.Contains("edge.depth > 0", ItemVisibilitySql.FindVisible, StringComparison.Ordinal);
        Assert.Contains(
            "edge.descendant_id = @item_id",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
    }

    [Fact]
    public void An_unresolved_template_or_nonactive_ancestor_fails_closed()
    {
        Assert.Contains("LEFT JOIN LATERAL", ItemVisibilitySql.FindVisible, StringComparison.Ordinal);
        Assert.Contains(
            "stored_ancestor.template_id IS NOT NULL",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
        Assert.Contains(
            "stored_ancestor.lifecycle_state IS DISTINCT FROM 'active'",
            ItemVisibilitySql.FindVisible,
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_descendant_range_and_point_probe_keep_the_measured_optimization_fences()
    {
        Assert.Contains("path AS MATERIALIZED", ItemVisibilitySql.FindVisible, StringComparison.Ordinal);
        Assert.Contains("LIMIT 1", ItemVisibilitySql.FindVisible, StringComparison.Ordinal);
    }
}
