using System.Globalization;
using System.Net;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Search;
using Nix.Persistence.Workers;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Proves the cross-tenant index hydration and durable rebuild boundary.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SearchIndexDispatchTests(
    NixPostgresFixture fixture,
    ITestOutputHelper output) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsMigratorAsync("DELETE FROM worker_outbox_event");
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Metadata_and_body_reads_are_exact_bounded_cross_tenant_projections()
    {
        const string bodyText = "Quarterly planning body";
        await ExecuteAsMigratorAsync(
            """
            UPDATE item_search
               SET body_text = @body,
                   body_vector = to_tsvector('english', @body),
                   seq = seq + 1,
                   updated_at = clock_timestamp()
             WHERE tenant_id = @tenant_id
               AND item_id = @item_id
            """,
            new NpgsqlParameter("body", bodyText),
            new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("item_id", M0SchemaSeed.Alpha.ItemId));

        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<SearchIndexDispatchStore>();
        var metadata = Assert.IsType<SearchIndexMetadataRecord>(await store.GetMetadataAsync(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.ItemId,
            Cancellation));

        Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, metadata.WorkspaceId);
        Assert.Equal(M0SchemaSeed.Alpha.ItemId, metadata.ItemId);
        Assert.Contains($"workspace:{M0SchemaSeed.Alpha.WorkspaceId:D}", metadata.AuthorizationKeys);
        Assert.Null(await store.GetMetadataAsync(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Beta.ItemId,
            Cancellation));

        var body = Assert.IsType<SearchIndexBodyLease>(await store.OpenBodyAsync(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.ItemId,
            Cancellation));
        await using (body.ConfigureAwait(false))
        {
            using var destination = new MemoryStream();
            await body.CopyToAsync(destination, Cancellation);
            Assert.Equal(bodyText, Encoding.UTF8.GetString(destination.GetBuffer(), 0, checked((int)destination.Length)));
        }
    }

    [Fact]
    public async Task Item_and_body_mutations_emit_monotonically_versioned_workspace_events()
    {
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            const string title = "Renamed";
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE item SET properties = jsonb_build_object('title', {title}), last_modified_at = clock_timestamp() WHERE tenant_id = {M0SchemaSeed.Alpha.TenantId} AND id = {M0SchemaSeed.Alpha.ItemId}",
                Cancellation);
            await work.CommitAsync(Cancellation);
        }

        await ExecuteAsMigratorAsync(
            """
            UPDATE item_search
               SET body_text = 'new body',
                   body_vector = to_tsvector('english', 'new body'),
                   seq = seq + 1,
                   updated_at = clock_timestamp()
             WHERE tenant_id = @tenant_id
               AND item_id = @item_id
            """,
            new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("item_id", M0SchemaSeed.Alpha.ItemId));

        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<IWorkerDispatchStore>();
        var events = await dispatch.LeaseOutboxAsync("item.changed", "index-test", 10, 60, Cancellation);
        var relevant = events.Where(value => value.ItemId == M0SchemaSeed.Alpha.ItemId).ToArray();

        Assert.True(relevant.Length >= 2);
        Assert.All(relevant, value => Assert.NotNull(value.AggregateVersion));
        Assert.Equal(relevant.Length, relevant.Select(value => value.AggregateVersion).Distinct().Count());
    }

    [Fact]
    public async Task Rebuild_pages_are_restartable_and_status_reports_durable_lag()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<SearchIndexDispatchStore>();

        var first = await store.EnqueueRebuildPageAsync(null, null, null, 1, Cancellation);
        Assert.Equal(1, first.Enqueued);
        Assert.True(first.HasMore);
        Assert.NotNull(first.NextTenantId);
        Assert.NotNull(first.NextItemId);

        var second = await store.EnqueueRebuildPageAsync(
            first.NextTenantId,
            first.NextItemId,
            null,
            10,
            Cancellation);
        Assert.True(second.Enqueued >= 1);
        Assert.False(second.HasMore);

        var status = await store.GetOutboxStatusAsync(Cancellation);
        Assert.Equal(first.Enqueued + second.Enqueued, status.Pending);
        Assert.NotNull(status.OldestAvailableAt);
        Assert.Equal(0, status.HighestAttempts);
        Assert.Equal(0, status.PendingFailures);
    }

    [Fact]
    public async Task OpenSearch_cutover_revalidates_stale_hits_through_authoritative_Postgres()
    {
        const string currentTitle = "Authoritative alpha title";
        await ExecuteAsMigratorAsync(
            "UPDATE item SET properties = jsonb_build_object('title', @title) WHERE tenant_id = @tenant_id AND id = @item_id",
            new NpgsqlParameter("title", currentTitle),
            new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("item_id", M0SchemaSeed.Alpha.ItemId));

        var response = $$$"""
            {"hits":{"hits":[
              {"_source":{"tenant_id":"{{{M0SchemaSeed.Alpha.TenantId:D}}}","workspace_id":"{{{M0SchemaSeed.Alpha.WorkspaceId:D}}}","item_id":"{{{M0SchemaSeed.Beta.ItemId:D}}}","type":"note","title":"Leaked stale title","lifecycle_state":"active","hidden":false,"deleted":false}},
              {"_source":{"tenant_id":"{{{M0SchemaSeed.Alpha.TenantId:D}}}","workspace_id":"{{{M0SchemaSeed.Alpha.WorkspaceId:D}}}","item_id":"{{{M0SchemaSeed.Alpha.ItemId:D}}}","type":"file","title":"Stale alpha title","lifecycle_state":"active","hidden":false,"deleted":false}}
            ]}}
            """;
        using var handler = new StaticOpenSearchHandler(response);
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("https://search.example.test/"),
            Timeout = Timeout.InfiniteTimeSpan,
        };
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var query = new OpenSearchItemQueryClient(
            httpClient,
            work.Resolve<INixSessionContextAccessor>(),
            "nix-items");
        var search = new OpenSearchItemSearch(query, work.Resolve<ItemSearch>());

        var results = await search.FindAsync(
            "alpha",
            [WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId)],
            20,
            Cancellation);

        var result = Assert.Single(results);
        Assert.Equal(M0SchemaSeed.Alpha.ItemId, result.Id.Value);
        Assert.Equal("folder", result.Type);
        Assert.Equal(currentTitle, result.Title);
    }

    [Fact]
    public async Task Exact_metadata_hydration_is_measured_against_a_realistic_workspace()
    {
        const int corpusSize = 3_200;
        await ExecuteAsMigratorAsync(
            """
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), @tenant_id, @workspace_id, 'note', NULL, 700000 + n,
                   jsonb_build_object('title', 'Index evidence ' || n), 'active', NULL,
                   @principal_id, @principal_id, clock_timestamp(), clock_timestamp()
              FROM generate_series(1, @corpus_size) n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
              FROM item
             WHERE tenant_id = @tenant_id
               AND seq BETWEEN 700001 AND 703200;

            ANALYZE item;
            ANALYZE item_closure;
            """,
            new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
            new NpgsqlParameter("principal_id", M0SchemaSeed.Alpha.PrincipalId),
            new NpgsqlParameter("corpus_size", corpusSize));

        var text = await ExplainProjectionAsRuntimeRoleAsync();
        output.WriteLine(
            "EXPLAIN (ANALYZE, BUFFERS), exact search hydration, {0} additional items:",
            corpusSize);
        output.WriteLine(text);
        Assert.Contains("Index Scan using \"AK_item_tenant_id_id\" on item", text, StringComparison.Ordinal);
        Assert.Contains("Index Scan using \"IX_item_closure_tenant_id_descendant_id\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item ", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", text, StringComparison.Ordinal);
        Assert.Contains("actual", text, StringComparison.Ordinal);
        Assert.Contains("rows=1", text, StringComparison.Ordinal);
    }

    private async Task<string> ExplainProjectionAsRuntimeRoleAsync()
    {
        const string projectionSql =
            """
            SELECT item.tenant_id,
                   item.workspace_id,
                   item.id,
                   item.parent_id,
                   item.type,
                   item.properties ->> 'title',
                   concat_ws(' ', item.properties::text, file.file_name, file.media_type),
                   COALESCE(item.properties, '{}'::jsonb),
                   COALESCE((
                       SELECT array_agg(edge.ancestor_id ORDER BY edge.depth DESC, edge.ancestor_id)
                         FROM item_closure edge
                        WHERE edge.tenant_id = item.tenant_id
                          AND edge.descendant_id = item.id
                          AND edge.depth > 0
                   ), ARRAY[]::uuid[]),
                   COALESCE((
                       SELECT array_agg(link.target_item_id ORDER BY link.target_item_id)
                         FROM item_link link
                        WHERE link.tenant_id = item.tenant_id
                          AND link.source_item_id = item.id
                   ), ARRAY[]::uuid[]),
                   ARRAY['workspace:' || item.workspace_id::text],
                   item.lifecycle_state,
                   item.lifecycle_state = 'active'
                       AND item.template_id IS NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM item_closure visibility_edge
                             JOIN item visibility_ancestor
                               ON visibility_ancestor.tenant_id = visibility_edge.tenant_id
                              AND visibility_ancestor.id = visibility_edge.ancestor_id
                            WHERE visibility_edge.tenant_id = item.tenant_id
                              AND visibility_edge.descendant_id = item.id
                              AND visibility_edge.depth > 0
                              AND (visibility_ancestor.lifecycle_state IS DISTINCT FROM 'active'
                                   OR visibility_ancestor.template_id IS NOT NULL)
                       ),
                   GREATEST(item.last_modified_at, COALESCE(search.updated_at, item.last_modified_at))
              FROM item
              LEFT JOIN item_search search
                ON search.tenant_id = item.tenant_id
               AND search.item_id = item.id
              LEFT JOIN file_body body
                ON body.tenant_id = item.tenant_id
               AND body.item_id = item.id
              LEFT JOIN file_version file
                ON file.tenant_id = body.tenant_id
               AND file.item_id = body.item_id
               AND file.file_version_id = body.current_version_id
             WHERE item.tenant_id = @tenant_id
               AND item.id = @item_id
            """;

        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
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
                    await context.ExecuteNonQueryAsync(Cancellation);
                }

                var command = new NpgsqlCommand(
                    "EXPLAIN (ANALYZE, BUFFERS) " + projectionSql,
                    connection,
                    transaction);
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid)
                    {
                        TypedValue = M0SchemaSeed.Alpha.TenantId,
                    });
                    command.Parameters.Add(new NpgsqlParameter<Guid>("item_id", NpgsqlDbType.Uuid)
                    {
                        TypedValue = M0SchemaSeed.Alpha.ItemId,
                    });
                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(Cancellation);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(Cancellation))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    return plan.ToString();
                }
            }
        }
    }

    private async Task ExecuteAsMigratorAsync(string sql, params NpgsqlParameter[] parameters)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: every statement passed here is production-owned static test SQL; values remain bound parameters.
            var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);
                await command.ExecuteNonQueryAsync(Cancellation).ConfigureAwait(false);
            }
        }
    }

    private sealed class StaticOpenSearchHandler(string responseBody) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(HttpMethod.Post, request.Method);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(responseBody, Encoding.UTF8, "application/json"),
            });
        }
    }
}
