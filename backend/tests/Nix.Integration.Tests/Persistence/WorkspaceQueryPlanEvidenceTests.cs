using System.Diagnostics;
using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Views;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The ad-hoc query's statements against a 10,000-item corpus, planned and executed as the
/// runtime role under row-level security: the plans are written to the test output for the change
/// record, and the assertions hold only what the design depends on.
/// </summary>
/// <remarks>
/// <para>
/// The corpus is the shape a dashboard reads: 100 containers of 99 items, every item with a
/// status, a number that is sometimes a word, a due date and a done flag, so a query neither
/// matches everything nor nothing, and a scope selects a real subtree through the closure.
/// </para>
/// <para>
/// No index is added for these statements. The bag predicates (<c>ILIKE</c>, the guarded number,
/// emptiness) are not leakproof, so under RLS no expression index over the bag could serve them -
/// <c>QuerySql</c>'s remarks record the measurement that settled that for the saved query. What
/// must hold is that the scope and <c>$inside</c> read the closure through its index rather than a
/// sequential pass, and that grouping and folding stay one pass over the match.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceQueryPlanEvidenceTests : IAsyncLifetime
{
    private const int Containers = 100;
    private const int ChildrenPerContainer = 99;

    private static readonly DateOnly Today = new(2026, 8, 15);

    /// <summary>The fiftieth container, the scope and the <c>$inside</c> ancestor below.</summary>
    private static readonly Guid Scope = new("9d9d9000-0000-4000-8000-000000000050");

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public WorkspaceQueryPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
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
    public async Task A_scoped_grouped_query_with_contains_and_a_group_reads_the_subtree_through_the_closure_index()
    {
        var spec = new QuerySpec(
            [
                new FilterRule("$type", "equals", "task"),
                new FilterRule("title", "contains", "item 5000"),
                FilterRule.Group(
                [
                    new FilterRule("status", "equals", "Doing"),
                    new FilterRule("points", "greater-than", "50"),
                ]),
            ],
            QueryOrder.Recency,
            Today)
        {
            Scope = new QueryScope(ItemId.From(Scope), Descendants: true),
            Grouping = new QueryGrouping("status", ["Todo", "Doing", "Done"]),
        };

        var compiled = QuerySql.Compile(spec);
        var plan = await ExplainAsync(compiled, ("scope_parent_id", Scope), ("limit", 101));
        _output.WriteLine("Scoped, grouped, contains + any-of, 10,000 items, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.Contains("item_closure", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure scope_edge", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_workspace_wide_query_with_inside_and_numbers_completes_with_a_bounded_sort()
    {
        var spec = new QuerySpec(
            [
                new FilterRule("$inside", "equals", Scope.ToString()),
                new FilterRule("points", "less-than", "70"),
                new FilterRule("due_date", "within-last", "30"),
            ],
            new QueryOrder("$created", IsDay: false, Descending: true),
            Today);

        var compiled = QuerySql.Compile(spec);
        var plan = await ExplainAsync(compiled, ("limit", 101));
        _output.WriteLine("Workspace-wide, $inside + less-than + within-last, sorted by $created, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("Limit", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_grouped_sum_over_the_whole_workspace_is_one_pass_over_the_match()
    {
        var spec = new QuerySpec([new FilterRule("$done", "not-equals", "true")], QueryOrder.Recency, Today)
        {
            Grouping = new QueryGrouping("status", []),
        };

        var compiled = QuerySql.CompileAggregate(spec, new QueryAggregate("sum", "points"));
        var stopwatch = Stopwatch.StartNew();
        var plan = await ExplainAsync(compiled, ("group_limit", 100));
        stopwatch.Stop();
        _output.WriteLine("Grouped sum of points over the open items, 10,000 items, runtime role ({0} ms round trip):", stopwatch.ElapsedMilliseconds);
        _output.WriteLine(plan);

        // The match is materialised once and both folds read the materialised rows.
        Assert.Contains("CTE matched", plan, StringComparison.Ordinal);
        Assert.True(Count(plan, "CTE Scan on matched") >= 2, "Expected both folds to read the materialised match.");
    }

    private static int Count(string text, string fragment)
    {
        var count = 0;
        for (var index = text.IndexOf(fragment, StringComparison.Ordinal); index >= 0; index = text.IndexOf(fragment, index + fragment.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private async Task<string> ExplainAsync(CompiledQuery compiled, params (string Name, object Value)[] extra)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                // set_config with is_local = true: the SET LOCAL context the middleware establishes.
                var context = new NpgsqlCommand("SELECT set_config('nix.tenant_id', @tenant, true)", connection, transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
                    {
                        Value = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture),
                    });
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: QuerySql's own compiled statement; input reaches it only as bound parameters, the property QueryStatementTests proves.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + compiled.Sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    foreach (var parameter in compiled.Parameters)
                    {
                        command.Parameters.Add(parameter.Clone());
                    }

                    command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.TenantId });
                    command.Parameters.Add(new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = new[] { M0SchemaSeed.Alpha.WorkspaceId } });
                    command.Parameters.Add(new NpgsqlParameter("closed_lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });
                    foreach (var (name, value) in extra)
                    {
                        command.Parameters.Add(value is Guid id
                            ? new NpgsqlParameter(name, NpgsqlDbType.Uuid) { Value = id }
                            : new NpgsqlParameter(name, NpgsqlDbType.Integer) { Value = value });
                    }

                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    return plan.ToString();
                }
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var tenant = $"'{M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
        var workspace = $"'{M0SchemaSeed.Alpha.WorkspaceId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
        var principal = $"'{M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture)}'::uuid";

        // Containers have deterministic ids (…000001 to …000100) so the scope can name one; their
        // children are random. Every tenth child stores its points as a word.
        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT ('9d9d9000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, {{tenant}}, {{workspace}},
                   'note', NULL, 100000 + c, jsonb_build_object('title', 'Container ' || c),
                   'active', NULL, {{principal}}, {{principal}}, now(), now()
            FROM generate_series(1, {{Containers}}) AS c;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}},
                   CASE WHEN n % 2 = 0 THEN 'task' ELSE 'note' END,
                   ('9d9d9000-0000-4000-8000-' || lpad(c::text, 12, '0'))::uuid, 200000 + c * 1000 + n,
                   jsonb_build_object(
                       'title', 'Bulk item ' || (c * 1000 + n),
                       'status', (ARRAY['Todo', 'Doing', 'Done'])[1 + n % 3],
                       'points', CASE WHEN n % 10 = 0 THEN to_jsonb('lots'::text) ELSE to_jsonb(n) END,
                       'due_date', to_char(DATE '2026-06-01' + (n % 120), 'YYYY-MM-DD'),
                       'completion', (n % 4 = 0)),
                   'active', NULL, {{principal}}, {{principal}},
                   TIMESTAMPTZ '2026-06-01T00:00:00Z' + make_interval(hours => n),
                   TIMESTAMPTZ '2026-06-01T00:00:00Z' + make_interval(hours => n)
            FROM generate_series(1, {{Containers}}) AS c, generate_series(1, {{ChildrenPerContainer}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE seq >= 100000 AND tenant_id = {{tenant}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, parent_id, tenant_id, workspace_id, 1 FROM item
             WHERE seq >= 200000 AND tenant_id = {{tenant}};

            ANALYZE item;
            ANALYZE item_closure;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
