using Nix.Persistence.Migrations;

namespace Nix.Tests.Persistence;

public sealed class TemplateMigrationSecurityTests
{
    [Fact]
    public void Every_template_table_gets_forced_tenant_isolation_and_runtime_grants()
    {
        var statements = new List<string>();

        TemplateSecuritySql.Apply(statements.Add);

        foreach (var table in new[]
                 {
                     "workspace_template", "template_operation", "template_operation_item",
                     "template_application", "template_application_item",
                 })
        {
            Assert.Contains(statements, sql => sql.Contains(
                $"ALTER TABLE {table} FORCE ROW LEVEL SECURITY", StringComparison.Ordinal));
            Assert.Contains(statements, sql => sql.Contains(
                $"CREATE POLICY {table}_tenant_isolation", StringComparison.Ordinal));
            Assert.Contains(statements, sql => sql.Contains(
                $"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO nix_app", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void The_migration_seeds_exactly_the_three_shipped_templates()
    {
        var statements = new List<string>();

        TemplateSecuritySql.Apply(statements.Add);
        var sql = string.Join('\n', statements);

        Assert.Contains("'seed.kanban'", sql, StringComparison.Ordinal);
        Assert.Contains("'seed.calendar'", sql, StringComparison.Ordinal);
        Assert.Contains("'seed.list'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'boot'", sql, StringComparison.Ordinal);
        Assert.Equal(3, sql.Split("|| '4'", StringSplitOptions.None).Length - 1);
        Assert.Equal(3, sql.Split("|| '8'", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("':template')::uuid", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("':root')::uuid", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("':source-root')::uuid", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Downgrade_deletes_hidden_items_before_the_hiding_columns_are_dropped()
    {
        var statements = new List<string>();

        TemplateSecuritySql.Revert(statements.Add);
        var sql = string.Join('\n', statements);

        Assert.Contains("UPDATE workspace_template", sql, StringComparison.Ordinal);
        Assert.Contains("DELETE FROM item WHERE template_id IS NOT NULL", sql, StringComparison.Ordinal);
        Assert.Contains("ALTER TABLE item FORCE ROW LEVEL SECURITY", sql, StringComparison.Ordinal);
    }
}
