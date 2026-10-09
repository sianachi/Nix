using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Workspace events remain durable and versioned for their shared consumers.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceOutboxEventTests(NixPostgresFixture fixture) : IAsyncLifetime
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

        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<IWorkerDispatchStore>();
        var titleEvent = Assert.Single(await dispatch.LeaseOutboxAsync(
            "item.changed", "workspace-event-test", 10, 60, Cancellation));

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

        var bodyEvent = Assert.Single(await dispatch.LeaseOutboxAsync(
            "item.changed", "workspace-event-test", 10, 60, Cancellation));

        foreach (var workspaceEvent in new[] { titleEvent, bodyEvent })
        {
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, workspaceEvent.TenantId);
            Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, workspaceEvent.WorkspaceId);
            Assert.Equal(M0SchemaSeed.Alpha.ItemId, workspaceEvent.ItemId);
            Assert.Equal("item.changed", workspaceEvent.Kind);
            Assert.NotNull(workspaceEvent.AggregateVersion);
        }

        Assert.True(bodyEvent.AggregateVersion > titleEvent.AggregateVersion);
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
}
