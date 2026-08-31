using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Workers;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Cross-tenant dispatch reveals only leased work and enforces lease ownership.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkerDispatchTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    /// <inheritdoc />
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_dispatch_lease_returns_bounded_work_from_multiple_tenants()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();

        var jobs = await store.LeaseJobsAsync("import.nix", "worker-one", 10, 60, Cancellation);

        Assert.Equal(2, jobs.Count);
        Assert.Equal(2, jobs.Select(job => job.TenantId).Distinct().Count());
        Assert.All(jobs, job => Assert.Equal(1, job.Attempts));
    }

    [Fact]
    public async Task Only_the_live_lease_owner_can_complete_a_job()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.Single(await store.LeaseJobsAsync("import.nix", "worker-one", 1, 60, Cancellation));

        var refused = await store.CompleteJobAsync(
            job.Id,
            "worker-two",
            succeeded: true,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);
        var completed = await store.CompleteJobAsync(
            job.Id,
            "worker-one",
            succeeded: true,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);

        Assert.False(refused);
        Assert.True(completed);
    }

    [Fact]
    public async Task Outbox_events_are_retried_or_acknowledged_by_their_lease_owner()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var first = Assert.Single(await store.LeaseOutboxAsync("item.changed", "indexer", 1, 60, Cancellation));

        Assert.False(await store.FinishOutboxAsync(first.Id, "other", succeeded: true, failureDetail: null, Cancellation));
        Assert.True(await store.FinishOutboxAsync(first.Id, "indexer", succeeded: false, failureDetail: "temporary", Cancellation));
    }

    [Fact]
    public async Task A_transient_job_failure_is_backed_off_instead_of_completed()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.Single(await store.LeaseJobsAsync("import.nix", "worker-one", 1, 60, Cancellation));

        Assert.True(await store.FinishJobAsync(
            job.Id,
            "worker-one",
            succeeded: false,
            retryable: true,
            result: null,
            errorCode: "import_source_unavailable",
            errorDetail: "temporary",
            Cancellation));
        var next = await store.LeaseJobsAsync("import.nix", "worker-two", 10, 60, Cancellation);
        Assert.DoesNotContain(next, leased => leased.Id == job.Id);
    }

    [Fact]
    public async Task A_broker_command_claims_only_the_exact_job_it_names()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();

        var claimed = await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation);

        Assert.NotNull(claimed);
        Assert.Equal(M0SchemaSeed.Alpha.AclEntryId, claimed.Id);
        Assert.Equal(M0SchemaSeed.Alpha.TenantId, claimed.TenantId);
        Assert.Null(await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-two:alpha", 60, Cancellation));
        Assert.NotNull(await store.ClaimJobAsync(M0SchemaSeed.Beta.AclEntryId, "worker-two:beta", 60, Cancellation));
    }

    [Fact]
    public async Task A_live_execution_can_renew_and_observe_its_control_state()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));

        Assert.False(await store.RenewJobAsync(job.Id, "worker-two:alpha", 60, Cancellation));
        Assert.True(await store.RenewJobAsync(job.Id, "worker-one:alpha", 60, Cancellation));

        var ownerState = Assert.IsType<WorkerExecutionState>(
            await store.GetJobStateAsync(job.Id, "worker-one:alpha", Cancellation));
        var observerState = Assert.IsType<WorkerExecutionState>(
            await store.GetJobStateAsync(job.Id, "worker-two:alpha", Cancellation));
        Assert.Equal("running", ownerState.Status);
        Assert.False(ownerState.CancellationRequested);
        Assert.True(ownerState.LeaseOwned);
        Assert.False(observerState.LeaseOwned);
    }

    [Fact]
    public async Task A_retryable_broker_result_schedules_a_new_durable_command()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));

        Assert.True(await store.FinishJobAsync(
            job.Id,
            "worker-one:alpha",
            succeeded: false,
            retryable: true,
            result: null,
            errorCode: "object_unavailable",
            errorDetail: "temporary",
            Cancellation));

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            const string sql = """
                SELECT count(*)
                  FROM worker_outbox_event
                 WHERE kind = 'worker.command'
                   AND payload ->> 'jobId' = @job_id
                   AND processed_at IS NULL
                   AND available_at > now()
                """;
            var command = new NpgsqlCommand(sql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("job_id", job.Id.ToString("D"));
                Assert.Equal(1L, await command.ExecuteScalarAsync(Cancellation));
            }
        }
    }
}
