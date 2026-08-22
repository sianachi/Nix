using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for the TaskSemantics indexes, gathered the only way it counts: as the runtime
/// role, with row security enforced, against a corpus big enough that the planner has a real
/// choice.
/// </summary>
/// <remarks>
/// <para>
/// <b>Both halves of that sentence are load-bearing, and the older evidence tests miss both.</b>
/// A plan gathered over the migrator connection bypasses row security, and under RLS a predicate
/// over <c>properties -&gt;&gt; key</c> can never be an index condition (<c>-&gt;&gt;</c> is not
/// leakproof) - the design measurement showed the same query and index differing 115x on the role
/// alone. And at three thousand rows Postgres seq-scans whatever the indexes say. So: 55,000 rows,
/// two tenants, <c>nix_app</c>, <c>SET LOCAL nix.tenant_id</c>, and assertions on what the
/// planner chose rather than on whether EXPLAIN produced output.
/// </para>
/// <para>
/// The corpus: 50 view-declaring containers and 49,950 dated children under tenant Alpha, plus
/// 5,000 rows under tenant Beta so the policy has something to exclude. Dates spread over ~200
/// days around the query day; a third completed.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class TaskSemanticsPlanEvidenceTests : IAsyncLifetime
{
    private const int AlphaChildren = 49_950;
    private const int Containers = 50;
    private const int BetaItems = 5_000;

    private static readonly Guid AlphaRoot = new("7a5c0000-1111-4111-8111-7a5c00000001");

    private static readonly DateOnly QueryDay = new(2026, 8, 15);

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public TaskSemanticsPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
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
    public async Task The_overdue_query_is_served_by_ix_item_due_day_with_no_seq_scan_and_no_sort()
    {
        var compiled = QuerySql.Compile(
            [
                new FilterRule("due_date", "before", "today"),
                new FilterRule("completion", "not-equals", "true"),
            ],
            new QueryOrder("due_date", IsDay: true, Descending: false),
            QueryDay);

        var plan = await ExplainAsRuntimeRoleAsync(compiled.Sql, compiled.Parameters);
        _output.WriteLine("Overdue, {0} readable rows, runtime role:", AlphaChildren + Containers);
        _output.WriteLine(plan);

        Assert.Contains("Index Scan using ix_item_due_day", plan, StringComparison.Ordinal);
        Assert.Contains("due_day <", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item item", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Parallel Seq Scan", plan, StringComparison.Ordinal);
        // The ascending index key IS the order: a Sort node would mean the ordering fell back to
        // the bag expression and the whole match set is being materialised again.
        Assert.DoesNotContain("Sort Method", plan, StringComparison.Ordinal);
        // The row-security qual is pinned as present, not left incidental: a future change that
        // let due_day be served ABOVE the policy would keep every shape assertion green.
        Assert.Contains("nix.tenant_id", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        AssertAncestorPointLookup(plan);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);

        // The two tenants exist so the policy has something to exclude - so the exclusion is
        // asserted, not implied: the same statement executed as Alpha returns rows, and none of
        // them is Beta's.
        var titles = await ExecuteTitlesAsRuntimeRoleAsync(compiled.Sql, compiled.Parameters);
        Assert.NotEmpty(titles);
        Assert.DoesNotContain(titles, title => title.Contains("Other tenant", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_next_seven_days_query_carries_both_day_bounds_in_the_index_condition()
    {
        var compiled = QuerySql.Compile(
            [new FilterRule("due_date", "within-next", "7")],
            new QueryOrder("due_date", IsDay: true, Descending: false),
            QueryDay);

        var plan = await ExplainAsRuntimeRoleAsync(compiled.Sql, compiled.Parameters);
        _output.WriteLine("Next 7 days, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("Index Scan using ix_item_due_day", plan, StringComparison.Ordinal);
        Assert.Contains("due_day >=", plan, StringComparison.Ordinal);
        Assert.Contains("due_day <=", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Parallel Seq Scan", plan, StringComparison.Ordinal);
        Assert.Contains("nix.tenant_id", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        AssertAncestorPointLookup(plan);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);

        var titles = await ExecuteTitlesAsRuntimeRoleAsync(compiled.Sql, compiled.Parameters);
        Assert.NotEmpty(titles);
        Assert.DoesNotContain(titles, title => title.Contains("Other tenant", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_calendar_container_arm_is_served_by_ix_item_declares_views()
    {
        var plan = await ExplainAsRuntimeRoleAsync(
            CalendarSql.WorkspaceCalendar,
            [
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid)
                {
                    Value = M0SchemaSeed.Alpha.WorkspaceId,
                },
                new NpgsqlParameter("from", NpgsqlDbType.Text) { Value = "2026-08-01" },
                new NpgsqlParameter("to", NpgsqlDbType.Text) { Value = "2026-08-31" },
                new NpgsqlParameter("entry_limit", NpgsqlDbType.Integer) { Value = 2000 },
            ]);
        _output.WriteLine("Workspace calendar, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("ix_item_declares_views", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        AssertAncestorPointLookup(plan);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_recurrence_candidate_read_keeps_both_partial_indexes_and_executes_visibility_probes()
    {
        var plan = await ExplainAsRuntimeRoleAsync(
            RecurrenceSql.WorkspaceRecurrenceCandidates,
            [
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid)
                {
                    Value = M0SchemaSeed.Alpha.WorkspaceId,
                },
                new NpgsqlParameter("from", NpgsqlDbType.Text) { Value = "2026-08-01" },
                new NpgsqlParameter("to", NpgsqlDbType.Text) { Value = "2026-08-31" },
                new NpgsqlParameter("candidate_limit", NpgsqlDbType.Integer) { Value = 501 },
            ]);
        _output.WriteLine("Workspace recurrence candidates, runtime role:");
        _output.WriteLine(plan);

        Assert.Contains("ix_item_declares_views", plan, StringComparison.Ordinal);
        Assert.Contains("ix_item_recurs", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        AssertAncestorPointLookup(plan);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
    }

    /// <summary>
    /// Executes a compiled statement in the same runtime context and returns the title column -
    /// the isolation half of the evidence, where the plan half above could be green while a
    /// mis-scoped read leaked.
    /// </summary>
    private async Task<List<string>> ExecuteTitlesAsRuntimeRoleAsync(
        string sql,
        IReadOnlyList<NpgsqlParameter> parameters)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(
                TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true)",
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
                    {
                        Value = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture),
                    });
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: the text is a statement this codebase compiled - user input reaches it only as bound parameters, the property QueryStatementTests proves.
                var command = new NpgsqlCommand(sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    foreach (var parameter in parameters)
                    {
                        command.Parameters.Add(parameter.Clone());
                    }

                    AddCommonParameters(command);

                    var titles = new List<string>();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        var titleOrdinal = reader.GetOrdinal("title");
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            if (!await reader.IsDBNullAsync(titleOrdinal, TestContext.Current.CancellationToken))
                            {
                                titles.Add(reader.GetString(titleOrdinal));
                            }
                        }
                    }

                    return titles;
                }
            }
        }
    }

    /// <summary>
    /// EXPLAINs a statement as the runtime role, under the one setting the row-security policy
    /// reads: <c>nix_app</c>, in a transaction with <c>SET LOCAL nix.tenant_id</c>. Production's
    /// middleware also sets <c>nix.workspace_id</c> and <c>nix.principal_id</c>, which no policy
    /// consults - the context here is a strict subset and cannot flatter a plan.
    /// </summary>
    private async Task<string> ExplainAsRuntimeRoleAsync(
        string sql,
        IReadOnlyList<NpgsqlParameter> parameters)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(
                TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                // set_config with is_local = true is the parameterisable spelling of SET LOCAL -
                // the exact context the middleware establishes, scoped to this transaction.
                var context = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true)",
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
                    {
                        Value = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture),
                    });
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: the text is a statement this codebase compiled - user input reaches it only as bound parameters, the property QueryStatementTests proves.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    foreach (var parameter in parameters)
                    {
                        command.Parameters.Add(parameter.Clone());
                    }

                    AddCommonParameters(command);

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

    /// <summary>Binds the names every statement here shares; extras a statement lacks are ignored
    /// only when it never names them, so each statement binds exactly what it declares.</summary>
    private static void AddCommonParameters(NpgsqlCommand command)
    {
        void AddIfMissing(string name, NpgsqlDbType type, object value)
        {
            foreach (NpgsqlParameter existing in command.Parameters)
            {
                if (string.Equals(existing.ParameterName, name, StringComparison.Ordinal))
                {
                    return;
                }
            }

            if (command.CommandText.Contains('@' + name, StringComparison.Ordinal))
            {
                command.Parameters.Add(new NpgsqlParameter(name, type) { Value = value });
            }
        }

        AddIfMissing("tenant_id", NpgsqlDbType.Uuid, M0SchemaSeed.Alpha.TenantId);
        AddIfMissing(
            "workspace_ids",
            NpgsqlDbType.Array | NpgsqlDbType.Uuid,
            new[] { M0SchemaSeed.Alpha.WorkspaceId });
        AddIfMissing("query_item_id", NpgsqlDbType.Uuid, Guid.Empty);
        AddIfMissing("limit", NpgsqlDbType.Integer, 501);
    }

    private static void AssertAncestorPointLookup(string plan) =>
        Assert.True(
            plan.Contains("AK_item_tenant_id_id", StringComparison.Ordinal)
            || plan.Contains(
                "Index Scan using \"PK_item\" on item visibility_ancestor",
                StringComparison.Ordinal),
            "Expected each visibility ancestor to be resolved through a point index lookup.");

    private async Task SeedCorpusAsync()
    {
        var alphaTenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var alphaWorkspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var alphaPrincipal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaTenant = Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = Literal(M0SchemaSeed.Beta.PrincipalId);

        // Containers first, each declaring a calendar view over the reserved due-date key, then
        // the children spread across them with dates around the query day and a third completed.
        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{Literal(AlphaRoot)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note', NULL, 199999,
                 '{"title":"Corpus root"}'::jsonb, 'active', NULL, {{alphaPrincipal}},
                 {{alphaPrincipal}}, now(), now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                   {{Literal(AlphaRoot)}}, 200000 + n,
                   jsonb_build_object('title', 'Container ' || n),
                   jsonb_build_object('views', jsonb_build_array(jsonb_build_object(
                       'id', 'v' || n, 'name', 'Calendar', 'kind', 'calendar',
                       'dateProperty', 'due_date'))),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{Containers}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, recurrence,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                   container.id,
                   300000 + n,
                   jsonb_build_object(
                       'title', 'Task ' || n,
                       'due_date', to_char(DATE '2026-05-01' + (n % 200), 'YYYY-MM-DD'),
                       'completion', (n % 3 = 0)),
                   CASE WHEN n % 100 = 0
                        THEN '{"freq":"daily","interval":1}'::jsonb
                        ELSE NULL END,
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{AlphaChildren}}) AS n
            JOIN item AS container
              ON container.tenant_id = {{alphaTenant}}
             AND container.seq = 200000 + 1 + (n % {{Containers}});

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{betaTenant}}, {{betaWorkspace}}, 'note', NULL, 400000 + n,
                   jsonb_build_object(
                       'title', 'Other tenant ' || n,
                       'due_date', to_char(DATE '2026-05-01' + (n % 200), 'YYYY-MM-DD')),
                   'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()
            FROM generate_series(1, {{BetaItems}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 199999;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{Literal(AlphaRoot)}}, tenant_id, workspace_id, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}}
              AND seq BETWEEN 200001 AND {{200000 + Containers}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, child.parent_id, child.tenant_id, child.workspace_id, 1
            FROM item AS child
            WHERE child.tenant_id = {{alphaTenant}}
              AND child.seq >= 300001;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, {{Literal(AlphaRoot)}}, child.tenant_id, child.workspace_id, 2
            FROM item AS child
            WHERE child.tenant_id = {{alphaTenant}}
              AND child.seq >= 300001;

            ANALYZE item;
            ANALYZE item_closure;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid id) =>
        $"'{id.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
