using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Notifications;
using Nix.Features.Notifications;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class NotificationsPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // These tests exercise first-write behavior, unlike the fully populated schema fixture.
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM principal_preferences");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM push_subscription");
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Preferences_survive_a_new_request_and_refuse_stale_writes()
    {
        var input = new PreferencesInput("Europe/London", "22:00", "07:00", "08:30", true, false, []);
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(0, input), Cancellation);
            Assert.True(saved.IsSuccess);
            Assert.Equal(1, saved.Value.Revision);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetPreferences, PrincipalPreferencesResponse>(new(), Cancellation);
            Assert.Equal(1, read.Revision);
            Assert.Equal("Europe/London", read.TimeZone);
            Assert.Equal("22:00", read.QuietStart);

            var conflict = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(0, input), Cancellation);
            Assert.True(conflict.IsFailure);
            Assert.Equal("notifications.preferences_conflict", conflict.Error.Code);

            var updated = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(1, input with { DueReminders = false }), Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.Equal(2, updated.Value.Revision);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task An_unknown_zone_and_a_malformed_time_are_refused()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var badZone = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Not/AZone", null, null, "09:00", true, true, [])), Cancellation);
            Assert.True(badZone.IsFailure);
            Assert.Equal("notifications.invalid_preferences", badZone.Error.Code);

            var badTime = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Etc/UTC", null, null, "9:00am", true, true, [])), Cancellation);
            Assert.True(badTime.IsFailure);
            Assert.Equal("notifications.invalid_preferences", badTime.Error.Code);
        }
    }

    [Fact]
    public async Task Preferences_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Etc/UTC", null, null, "09:00", true, true, [])), Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PrincipalPreferences>().AsNoTracking().ToListAsync(Cancellation));
                var store = work.Resolve<IPrincipalPreferencesStore>();
                Assert.Null(await store.FindAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
            }
        }
    }

    [Fact]
    public async Task Preferences_rls_refuses_a_forged_owner_on_insert()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.Resolve<IPrincipalPreferencesStore>().SaveAsync(new PrincipalPreferences
            {
                TenantId = TestTenants.BetaContext.TenantId,
                PrincipalId = TestTenants.BetaContext.PrincipalId,
                TimeZone = "Etc/UTC",
                DueReminderTime = new TimeOnly(9, 0),
                DueReminders = true,
                HabitReminders = true,
                MutedContainerIds = [],
                Revision = 1,
            }, 0, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    [Fact]
    public async Task Creating_a_notification_twice_with_the_same_dedupe_key_returns_the_first_one()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var writer = work.Resolve<INotificationWriter>();
            var first = await writer.CreateAsync(TestTenants.AlphaContext.PrincipalId, NotificationKind.Reminder,
                "Task due", "Finish the report", null, null, "reminder:same-key", Cancellation);
            var second = await writer.CreateAsync(TestTenants.AlphaContext.PrincipalId, NotificationKind.Reminder,
                "Different title", "Different body", null, null, "reminder:same-key", Cancellation);
            Assert.Equal(first.Id, second.Id);
            Assert.Equal("Task due", second.Title);

            var store = work.Resolve<INotificationStore>();
            var (unread, revision) = await store.SummaryAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation);
            Assert.Equal(1, unread);
            Assert.True(revision > 0);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Notifications_rls_refuses_writing_to_another_principal()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var writer = work.Resolve<INotificationWriter>();
            var error = await Assert.ThrowsAsync<PostgresException>(() => writer.CreateAsync(
                TestTenants.BetaContext.PrincipalId, NotificationKind.System, "Forged", "Forged", null, null, "forged-key", Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    [Fact]
    public async Task Notifications_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<INotificationWriter>().CreateAsync(TestTenants.AlphaContext.PrincipalId,
                NotificationKind.System, "Alpha only", "Alpha only body", null, null, "alpha-only", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<Notification>().AsNoTracking().ToListAsync(Cancellation));
            }
        }
    }

    [Fact]
    public async Task Marking_read_updates_the_unread_count_and_refuses_someone_elses_notification()
    {
        Guid notificationId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<INotificationWriter>().CreateAsync(TestTenants.AlphaContext.PrincipalId,
                NotificationKind.Reminder, "Read me", "Body", null, null, "read-me", Cancellation);
            notificationId = created.Id;
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(notificationId), Cancellation);
            Assert.True(read.IsSuccess);
            Assert.Equal(0, read.Value.Unread);

            var missing = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(Guid.NewGuid()), Cancellation);
            Assert.True(missing.IsFailure);
            Assert.Equal("notifications.not_found", missing.Error.Code);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Push_subscriptions_round_trip_and_refuse_a_bad_endpoint()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var p256dh = Convert.ToBase64String(new byte[65]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var auth = Convert.ToBase64String(new byte[16]).TrimEnd('=').Replace('+', '-').Replace('/', '_');

            var saved = await dispatcher.SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/abc", p256dh, auth, "test-agent"), Cancellation);
            Assert.True(saved.IsSuccess);

            var disallowed = await dispatcher.SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://attacker.example.com/collect", p256dh, auth, "test-agent"), Cancellation);
            Assert.True(disallowed.IsFailure);
            Assert.Equal("notifications.invalid_subscription", disallowed.Error.Code);

            var removed = await dispatcher.SendAsync<RemovePushSubscription, bool>(new("https://fcm.googleapis.com/fcm/send/abc"), Cancellation);
            Assert.True(removed.IsSuccess);
            Assert.True(removed.Value);

            var removedAgain = await dispatcher.SendAsync<RemovePushSubscription, bool>(new("https://fcm.googleapis.com/fcm/send/abc"), Cancellation);
            Assert.True(removedAgain.IsSuccess);
            Assert.False(removedAgain.Value);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Push_subscriptions_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var p256dh = Convert.ToBase64String(new byte[65]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var auth = Convert.ToBase64String(new byte[16]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/xyz", p256dh, auth, "test-agent"), Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PushSubscription>().AsNoTracking().ToListAsync(Cancellation));
            }
        }
    }
}
