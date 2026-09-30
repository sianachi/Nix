using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Scheduling;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Proves ADR-0051 section 1 and 2 against real Postgres: the <c>scheduled_trigger</c> table's
/// isolation and grants, the <c>nix_lease_due_triggers</c> / <c>nix_finish_trigger</c> SECURITY
/// DEFINER functions, the planner's idempotent reconcile, the dispatcher's retry backoff, and
/// retention.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SchedulingPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM scheduled_trigger");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
        }
        SystemTestTriggerSource.Reset();
    }

    public ValueTask DisposeAsync()
    {
        SystemTestTriggerSource.Reset();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task Scheduled_trigger_grants_the_application_role_only()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var (role, expected) in new[] { ("nix_app", true), ("nix_collab", false) })
            {
                var command = connection.CreateCommand();
                await using (command.ConfigureAwait(false))
                {
                    command.CommandText = "SELECT has_table_privilege(@role, 'scheduled_trigger', 'SELECT')";
                    command.Parameters.AddWithValue("role", role);
                    Assert.Equal(expected, (bool)(await command.ExecuteScalarAsync(Cancellation))!);
                }
            }

            foreach (var function in new[]
            {
                "nix_lease_due_triggers(integer, text, integer, integer)",
                "nix_finish_trigger(uuid, uuid, text, text, jsonb)",
                "nix_purge_finished_triggers(integer)",
                "nix_purge_old_notifications(integer)",
                "nix_find_explicit_reminder_candidates(timestamptz, timestamptz, integer, timestamptz, uuid)",
                "nix_find_due_reminder_candidates(date, date, integer, date, uuid)",
                "nix_find_habit_reminder_candidates(integer, uuid)",
                "nix_reminder_preferences_for(uuid[])",
                "nix_safe_timestamptz(text)",
                "nix_safe_date(text)",
                "nix_safe_uuid(text)",
            })
            {
                foreach (var (role, expected) in new[] { ("nix_app", true), ("nix_collab", false) })
                {
                    var command = connection.CreateCommand();
                    await using (command.ConfigureAwait(false))
                    {
                        command.CommandText = "SELECT has_function_privilege(@role, @function, 'EXECUTE')";
                        command.Parameters.AddWithValue("role", role);
                        command.Parameters.AddWithValue("function", function);
                        Assert.Equal(expected, (bool)(await command.ExecuteScalarAsync(Cancellation))!);
                    }
                }
            }
        }
    }

    [Fact]
    public async Task Scheduled_trigger_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<IScheduledTriggerStore>().UpsertPendingAsync(
                TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.WorkspaceId, TestTenants.AlphaContext.PrincipalId,
                TriggerKind.System, "system.test", null, null, DateTimeOffset.UtcNow.AddMinutes(5), "alpha-only", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<ScheduledTrigger>().AsNoTracking().ToListAsync(Cancellation));
            }
        }
    }

    [Fact]
    public async Task A_forged_owner_on_insert_is_refused_by_rls()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.DbContext.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO scheduled_trigger
                    (tenant_id, id, principal_id, kind, source, fire_at, dedupe_key, status, attempts, created_at, updated_at)
                VALUES ({TestTenants.Alpha}, {Guid.NewGuid()}, {TestTenants.BetaPrincipal}, 'system', 'system.test', now(), 'forged', 'pending', 0, now(), now())
                """, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    [Fact]
    public async Task Lease_due_triggers_claims_a_due_row_and_finish_only_succeeds_for_the_current_owner()
    {
        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<IScheduledTriggerStore>().UpsertPendingAsync(
                TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.WorkspaceId, TestTenants.AlphaContext.PrincipalId,
                TriggerKind.System, "system.test", null, null, DateTimeOffset.UtcNow.AddSeconds(-1), "due-now", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        var leased = await leases.LeaseDueAsync(10, "owner-a", 30, 5, Cancellation);
        var due = Assert.Single(leased, trigger => trigger.DedupeKey == "due-now");
        Assert.Equal(1, due.Attempts);
        Assert.Equal(TestTenants.AlphaContext.TenantId, due.TenantId);

        // Still leased: a second lease pass with a different owner must not reclaim it.
        var second = await leases.LeaseDueAsync(10, "owner-b", 30, 5, Cancellation);
        Assert.DoesNotContain(second, trigger => trigger.DedupeKey == "due-now");

        // The wrong owner cannot finish someone else's lease.
        Assert.False(await leases.FinishAsync(due.TenantId, due.Id, "owner-b", TriggerStatus.Fired, null, Cancellation));

        // The current owner can.
        Assert.True(await leases.FinishAsync(due.TenantId, due.Id, "owner-a", TriggerStatus.Fired, """{"reason":"ok"}""", Cancellation));

        // And a second finish, now that the lease is gone, fails too.
        Assert.False(await leases.FinishAsync(due.TenantId, due.Id, "owner-a", TriggerStatus.Fired, null, Cancellation));
    }

    [Fact]
    public async Task A_lease_that_outlived_its_process_past_the_attempt_cap_is_skipped_rather_than_re_leased()
    {
        // ADR-0051 Amendment 2, owed by lane B1: a lease nobody ever finished (the process holding
        // it died mid-fire) must not be handed out forever just because it keeps expiring. Seeded
        // directly as an already-leased, already-expired, already-at-the-cap row - the shape
        // nothing in the dispatcher's own failure handling ever produces, since that handling only
        // runs for a process that is still there to run it.
        var connection = await fixture.OpenMigratorConnectionAsync();
        var deadId = Guid.NewGuid();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO scheduled_trigger
                    (tenant_id, id, principal_id, kind, source, fire_at, dedupe_key, status, attempts,
                     lease_owner, lease_until, created_at, updated_at)
                VALUES ('{TestTenants.Alpha}', '{deadId}', '{TestTenants.AlphaPrincipal}', 'system',
                        'system.test', now() - interval '1 hour', 'dead-lease', 'leased', 5,
                        'dead-owner', now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 minute');
                """);
        }

        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();
        var leased = await leases.LeaseDueAsync(10, "owner-new", 30, 5, Cancellation);
        Assert.DoesNotContain(leased, trigger => trigger.DedupeKey == "dead-lease");

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var row = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(candidate => candidate.Id == deadId, Cancellation);
            Assert.Equal(TriggerStatus.Skipped, row.Status);
            Assert.Null(row.LeaseOwner);
            Assert.Null(row.LeaseUntil);
        }
    }

    [Fact]
    public async Task A_backed_off_retry_still_pending_is_left_alone_by_the_next_planning_pass()
    {
        // ADR-0051 Amendment 2, owed by lane B1: a trigger the dispatcher already retried once
        // (attempts > 0, still pending, fire_at pushed into the future by backoff) must not have
        // that backoff overwritten the very next time the source that produced it replans - or the
        // backoff could never actually elapse.
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        var context = TestTenants.AlphaContext;

        var connection = await fixture.OpenMigratorConnectionAsync();
        var backedOffId = Guid.NewGuid();
        var backedOffFireAt = DateTimeOffset.UtcNow.AddMinutes(30);
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO scheduled_trigger
                    (tenant_id, id, principal_id, kind, source, fire_at, dedupe_key, status, attempts, created_at, updated_at)
                VALUES ('{context.TenantId.Value}', '{backedOffId}', '{context.PrincipalId.Value}', 'system',
                        'system.test', '{backedOffFireAt:O}', 'backed-off', 'pending', 2, now(), now());
                """);
        }

        // The source still wants this same dedupe key, but at a different (earlier) instant than
        // the backoff currently holds it at - exactly what a source recomputes on every pass.
        SystemTestTriggerSource.Want(new DesiredTrigger(
            context.TenantId, context.WorkspaceId, context.PrincipalId, null, null,
            DateTimeOffset.UtcNow.AddMinutes(1), "backed-off"));
        await planner.PlanOnceAsync(Cancellation);

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var row = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(candidate => candidate.Id == backedOffId, Cancellation);
            Assert.Equal(TriggerStatus.Pending, row.Status);
            Assert.Equal(2, row.Attempts);
            Assert.Equal(backedOffFireAt, row.FireAt, TimeSpan.FromSeconds(1));
        }
    }

    [Fact]
    public async Task The_planner_upserts_by_dedupe_key_and_cancels_what_a_source_no_longer_desires()
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);

        var context = TestTenants.AlphaContext;
        var firstFireAt = DateTimeOffset.UtcNow.AddHours(1);
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, context.WorkspaceId, context.PrincipalId, null, null, firstFireAt, "plan-a"));
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, context.WorkspaceId, context.PrincipalId, null, null, firstFireAt, "plan-b"));
        await planner.PlanOnceAsync(Cancellation);

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .Where(row => row.PrincipalId == context.PrincipalId)
                .ToListAsync(Cancellation);
            Assert.Equal(2, rows.Count);
            Assert.All(rows, row => Assert.Equal(TriggerStatus.Pending, row.Status));
        }

        // Replanning with a moved fire_at upserts in place rather than duplicating.
        var movedFireAt = firstFireAt.AddMinutes(30);
        SystemTestTriggerSource.Reset();
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, context.WorkspaceId, context.PrincipalId, null, null, movedFireAt, "plan-a"));
        await planner.PlanOnceAsync(Cancellation);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .Where(row => row.PrincipalId == context.PrincipalId)
                .ToListAsync(Cancellation);
            var kept = Assert.Single(rows, row => row.DedupeKey == "plan-a");
            Assert.Equal(TriggerStatus.Pending, kept.Status);
            Assert.Equal(movedFireAt, kept.FireAt, TimeSpan.FromSeconds(1));

            var cancelled = Assert.Single(rows, row => row.DedupeKey == "plan-b");
            Assert.Equal(TriggerStatus.Cancelled, cancelled.Status);
        }

        // A cancelled dedupe key becoming desired again (a due date moved away, then back) must
        // be revived rather than left dead until retention removes it.
        var revivedFireAt = movedFireAt.AddMinutes(15);
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, context.WorkspaceId, context.PrincipalId, null, null, revivedFireAt, "plan-b"));
        await planner.PlanOnceAsync(Cancellation);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var revived = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.PrincipalId == context.PrincipalId && row.DedupeKey == "plan-b", Cancellation);
            Assert.Equal(TriggerStatus.Pending, revived.Status);
            Assert.Equal(revivedFireAt, revived.FireAt, TimeSpan.FromSeconds(1));
        }
    }

    [Fact]
    public async Task Reconciling_one_workspace_never_cancels_the_same_principals_pending_rows_in_another()
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);

        var context = TestTenants.AlphaContext;
        var otherWorkspace = Nix.Domain.Tenancy.WorkspaceId.From(Guid.NewGuid());
        var fireAt = DateTimeOffset.UtcNow.AddHours(1);

        // Two workspaces the same principal has a trigger in. scheduled_trigger carries no
        // foreign key to workspace (it is derived planning state, not a reference), so a
        // synthetic workspace id here is exactly as valid as a real one.
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, context.WorkspaceId, context.PrincipalId, null, null, fireAt, "workspace-a"));
        SystemTestTriggerSource.Want(new DesiredTrigger(context.TenantId, otherWorkspace, context.PrincipalId, null, null, fireAt, "workspace-b"));
        await planner.PlanOnceAsync(Cancellation);

        // A second, unchanged pass is what exposed the bug: reconciling workspace A's group would
        // cancel workspace B's still-desired row because the old CancelStale filtered only by
        // principal and kind, never workspace.
        await planner.PlanOnceAsync(Cancellation);

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .Where(row => row.PrincipalId == context.PrincipalId
                    && (row.DedupeKey == "workspace-a" || row.DedupeKey == "workspace-b"))
                .ToListAsync(Cancellation);
            Assert.Equal(2, rows.Count);
            Assert.All(rows, row => Assert.Equal(TriggerStatus.Pending, row.Status));
        }
    }

    [Fact]
    public async Task Plan_then_fire_delivers_a_system_notification_end_to_end()
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();
        var retention = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IRetentionStore>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        using var dispatcher = new ScheduleDispatcher(leases, retention, scopeFactory, TimeProvider.System);

        // Fires 200ms after planning, not exactly "now": PlanAsync's own window starts at the
        // instant the planner reads the clock, a moment after this trigger's fire_at was chosen,
        // so a fire_at of exactly "now" can already be in the past by the time PlanAsync filters
        // by it. The short wait before dispatching then makes the row due.
        var context = TestTenants.AlphaContext;
        SystemTestTriggerSource.Want(new DesiredTrigger(
            context.TenantId, context.WorkspaceId, context.PrincipalId, null, null,
            DateTimeOffset.UtcNow.AddMilliseconds(200), "e2e-fire"));
        await planner.PlanOnceAsync(Cancellation);
        await Task.Delay(TimeSpan.FromMilliseconds(300), Cancellation);

        var processed = await dispatcher.DispatchOnceAsync(Cancellation);
        Assert.Equal(1, processed);

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.DedupeKey == "e2e-fire", Cancellation);
            Assert.Equal(TriggerStatus.Fired, trigger.Status);

            var notification = await work.DbContext.Set<Notification>().AsNoTracking()
                .SingleOrDefaultAsync(row => row.DedupeKey == "system-test-fired:e2e-fire", Cancellation);
            Assert.NotNull(notification);
            Assert.Equal(NotificationKind.System, notification!.Kind);
        }
    }

    [Fact]
    public async Task An_unknown_trigger_source_is_skipped_by_name_not_guessed_by_kind()
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();
        var retention = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IRetentionStore>();
        using var dispatcher = new ScheduleDispatcher(leases, retention, scopeFactory, TimeProvider.System);

        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            // A trigger whose source name no registered ITriggerSource carries: the dispatcher
            // must not fall back to any source sharing the same Kind - Kind is a display category,
            // never a dispatch key - so this is skipped as "unknown_source" even though its Kind
            // (System) is exactly what SystemTestTriggerSource itself reports.
            await work.Resolve<IScheduledTriggerStore>().UpsertPendingAsync(
                context.TenantId, context.WorkspaceId, context.PrincipalId,
                TriggerKind.System, "reminder.nonexistent", null, null, DateTimeOffset.UtcNow.AddSeconds(-1), "no-source", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        var processed = await dispatcher.DispatchOnceAsync(Cancellation);
        Assert.Equal(1, processed);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.DedupeKey == "no-source", Cancellation);
            Assert.Equal(TriggerStatus.Skipped, trigger.Status);
            Assert.Contains("unknown_source", trigger.Detail, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Reconciling_one_sources_desired_set_never_cancels_another_sources_rows_of_the_same_kind()
    {
        // ADR-0051 Amendment 2 / the architect's dispatch redesign: two sources can share a Kind
        // (both are System here, for the test's convenience - the point is Kind alone must not
        // scope the cancel) without one source's replan touching the other's still-desired rows.
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        var context = TestTenants.AlphaContext;

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<IScheduledTriggerStore>();
            // "other.source" plants a row of the same Kind, Tenant, Workspace and Principal that
            // the real System-source planning pass below never mentions - it must survive.
            await store.UpsertPendingAsync(
                context.TenantId, context.WorkspaceId, context.PrincipalId,
                TriggerKind.System, "other.source", null, null, DateTimeOffset.UtcNow.AddHours(1),
                "other-source-row", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        SystemTestTriggerSource.Want(new DesiredTrigger(
            context.TenantId, context.WorkspaceId, context.PrincipalId, null, null,
            DateTimeOffset.UtcNow.AddHours(1), "system-test-row"));
        await planner.PlanOnceAsync(Cancellation);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var other = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.DedupeKey == "other-source-row", Cancellation);
            Assert.Equal(TriggerStatus.Pending, other.Status);

            var own = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.DedupeKey == "system-test-row", Cancellation);
            Assert.Equal(TriggerStatus.Pending, own.Status);
            Assert.Equal("system.test", own.Source);
        }
    }

    [Fact]
    public void Two_registered_trigger_sources_sharing_a_name_are_refused()
    {
        ITriggerSource first = new NamedStubTriggerSource("reminder.due");
        ITriggerSource second = new NamedStubTriggerSource("reminder.due");

        var error = Assert.Throws<InvalidOperationException>(
            () => TriggerSourceNames.RequireUnique([first, second]));
        Assert.Contains("reminder.due", error.Message, StringComparison.Ordinal);
    }

    /// <summary>A minimal <see cref="ITriggerSource"/> whose only purpose is to carry a Name for the uniqueness check.</summary>
    private sealed class NamedStubTriggerSource(string name) : ITriggerSource
    {
        public string Name => name;

        public TriggerKind Kind => TriggerKind.Reminder;

        public Task<IReadOnlyList<DesiredTrigger>> PlanAsync(PlanWindow window, CancellationToken cancellationToken) =>
            throw new NotSupportedException("Not exercised by the uniqueness check.");

        public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
            throw new NotSupportedException("Not exercised by the uniqueness check.");
    }

    [Fact]
    public async Task Retention_purges_only_old_finished_triggers_and_old_notifications()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO scheduled_trigger
                    (tenant_id, id, principal_id, kind, source, fire_at, dedupe_key, status, attempts, created_at, updated_at)
                VALUES ('{TestTenants.Alpha}', '{Guid.NewGuid()}', '{TestTenants.AlphaPrincipal}', 'system', 'system.test',
                        now() - interval '40 days', 'old-fired', 'fired', 1, now() - interval '40 days', now() - interval '40 days'),
                       ('{TestTenants.Alpha}', '{Guid.NewGuid()}', '{TestTenants.AlphaPrincipal}', 'system', 'system.test',
                        now() - interval '1 hour', 'recent-fired', 'fired', 1, now() - interval '1 hour', now() - interval '1 hour');

                INSERT INTO notification (tenant_id, id, principal_id, kind, title, body, created_at, dedupe_key)
                VALUES ('{TestTenants.Alpha}', '{Guid.NewGuid()}', '{TestTenants.AlphaPrincipal}', 'system', 'Old', 'Old',
                        now() - interval '91 days', 'old-notification'),
                       ('{TestTenants.Alpha}', '{Guid.NewGuid()}', '{TestTenants.AlphaPrincipal}', 'system', 'Recent', 'Recent',
                        now() - interval '1 hour', 'recent-notification');
                """);
        }

        var retention = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IRetentionStore>();
        var purgedTriggers = await retention.PurgeFinishedTriggersAsync(500, Cancellation);
        var purgedNotifications = await retention.PurgeOldNotificationsAsync(500, Cancellation);
        Assert.Equal(1, purgedTriggers);
        Assert.Equal(1, purgedNotifications);

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var remainingTriggerKeys = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .Select(row => row.DedupeKey).ToListAsync(Cancellation);
            Assert.Contains("recent-fired", remainingTriggerKeys);
            Assert.DoesNotContain("old-fired", remainingTriggerKeys);

            var remainingNotificationKeys = await work.DbContext.Set<Notification>().AsNoTracking()
                .Select(row => row.DedupeKey).ToListAsync(Cancellation);
            Assert.Contains("recent-notification", remainingNotificationKeys);
            Assert.DoesNotContain("old-notification", remainingNotificationKeys);
        }
    }
}
