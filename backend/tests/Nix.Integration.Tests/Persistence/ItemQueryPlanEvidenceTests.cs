using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;
using Xunit.Sdk;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The query statement's plan, measured against a realistically sized corpus rather than five
/// seeded rows - the rule CLAUDE.md states and the one GraphSql taught the cost of skipping: a doc
/// comment naming an index is a hypothesis, and the plan is the evidence.
/// </summary>
/// <remarks>
/// The corpus is 3,200 dated items in one workspace, the scale the MVP plan's stress rows name.
/// The test asserts the read completes and stays under the limit; the plan itself is written to
/// the test output for the change record. As of the goal that added this, the expected shape is a
/// scan bounded by <c>IX_item_tenant_id_workspace_id</c> with a top-N sort under the LIMIT - no
/// jsonb index is claimed, and none exists. If this corpus ever shows that hurting, the recorded
/// escape hatch is an <c>@&gt;</c> containment arm plus a GIN <c>jsonb_path_ops</c> index in a
/// later goal's migration.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ItemQueryPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSize = 3200;

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public ItemQueryPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_overdue_query_over_three_thousand_items_runs_and_its_plan_is_recorded()
    {
        var compiled = QuerySql.Compile(
            [
                new FilterRule("due", "before", "today"),
                new FilterRule("done", "not-equals", "true"),
            ],
            new QueryOrder("due", IsDay: true, Descending: false),
            new DateOnly(2026, 8, 15));

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: the text is QuerySql's own compiled statement - user input reaches it only as bound parameters, which is the property QueryStatementTests proves.
            var command = new NpgsqlCommand(
                "EXPLAIN (ANALYZE, BUFFERS) " + compiled.Sql,
                connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                foreach (var parameter in compiled.Parameters)
                {
                    command.Parameters.Add(parameter.Clone());
                }

                command.Parameters.Add(
                    new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid)
                    {
                        Value = M0SchemaSeed.Alpha.TenantId,
                    });
                command.Parameters.Add(
                    new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
                    {
                        Value = new[] { M0SchemaSeed.Alpha.WorkspaceId },
                    });
                command.Parameters.Add(
                    new NpgsqlParameter("query_item_id", NpgsqlDbType.Uuid)
                    {
                        Value = Guid.Empty,
                    });
                command.Parameters.Add(
                    new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = 501 });

                var plan = new StringBuilder();
                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        plan.AppendLine(reader.GetString(0));
                    }
                }

                var text = plan.ToString();
                _output.WriteLine("EXPLAIN (ANALYZE, BUFFERS), overdue query, {0} items:", CorpusSize);
                _output.WriteLine(text);

                // The assertions are about honesty, not speed: the statement ran against the
                // corpus, produced a plan, and the plan carries a Limit node - the top-N bound
                // that keeps the sort from materialising the workspace.
                Assert.Contains("Limit", text, StringComparison.Ordinal);
                Assert.Contains("actual", text, StringComparison.Ordinal);
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var tenant = $"'{M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
        var workspace = $"'{M0SchemaSeed.Alpha.WorkspaceId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
        var principal = $"'{M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";

        // A spread of dates around today (2026-08-15), a third of them done: roughly half the
        // corpus is overdue-shaped, so the query neither matches everything nor nothing.
        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', NULL, 100000 + n,
                   jsonb_build_object(
                       'title', 'Bulk item ' || n,
                       'due', to_char(DATE '2026-05-01' + (n % 200), 'YYYY-MM-DD'),
                       'done', (n % 3 = 0)),
                   'active', NULL, {{principal}}, {{principal}}, now(), now()
            FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 100000 AND tenant_id = {{tenant}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
