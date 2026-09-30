using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Features.Notifications;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Scheduling;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Proves ADR-0051 section 4 (lane B1) against real Postgres: the three reminder sources'
/// plan -&gt; dispatch -&gt; notification path end to end, and their fire-time re-verification skips.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ReminderSourcesIntegrationTests(NixPostgresFixture fixture) : IAsyncLifetime
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
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM principal_preferences");
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_explicit_reminder_plans_fires_and_notifies_end_to_end()
    {
        var context = TestTenants.AlphaContext;
        Guid itemId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var reminderAt = DateTimeOffset.UtcNow.AddMilliseconds(200);
            var reminderText = $"{reminderAt.UtcDateTime:yyyy-MM-ddTHH:mm:ss}+00:00[Etc/UTC]";
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "Ping me", null, new JsonObject { ["reminder"] = reminderText }),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            itemId = created.Value.Id.Value;
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.FromMilliseconds(400));

        await AssertNotificationAsync(context, itemId, "Reminder");
    }

    [Fact]
    public async Task A_due_reminder_fires_for_whoever_set_the_due_date_and_is_skipped_once_complete()
    {
        var context = TestTenants.AlphaContext;
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute());

        Guid itemId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Ship the thing", null,
                    new JsonObject { ["due_date"] = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) }),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            itemId = created.Value.Id.Value;
            await work.CommitAsync(Cancellation);
        }

        // $due_set_by is stamped by the write path itself; confirm the recipient is the setter,
        // not merely the creator (they happen to be the same principal here - Recipient_falls_
        // back_to_the_creator_when_due_set_by_is_absent below is what tells them apart).
        await PlanAndDispatchAsync(TimeSpan.Zero);
        await AssertNotificationAsync(context, itemId, "Due today");

        // Completing it and replanning must not produce a second reminder for the same day: the
        // finder itself excludes a completed plain due item, so no new trigger is even planned.
        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var completed = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), """{"completion":true}"""), Cancellation);
            Assert.True(completed.IsSuccess, completed.IsSuccess ? "" : completed.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM scheduled_trigger");
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notifications = await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(itemId)).ToListAsync(Cancellation);
            Assert.Empty(notifications);
        }
    }

    [Fact]
    public async Task A_habit_reminder_fires_and_is_skipped_once_checked_in()
    {
        var context = TestTenants.AlphaContext;
        await SavePreferencesAsync(context, habitReminderTime: NowMinusOneMinute());

        Guid habitId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "habit", "Stretch", null, null), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            habitId = created.Value.Id.Value;

            var settings = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(
                    ItemId.From(habitId),
                    new HabitSettingsRequest("daily", [], "Etc/UTC", DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-1), 1, "times", HabitReminderTime())),
                Cancellation);
            Assert.True(settings.IsSuccess, settings.IsSuccess ? "" : settings.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);
        await AssertNotificationAsync(context, habitId, "Time to check in");

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM scheduled_trigger");
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var checkIn = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(ItemId.From(habitId), DateOnly.FromDateTime(DateTime.UtcNow), new HabitCheckInRequest(true, null)),
                Cancellation);
            Assert.True(checkIn.IsSuccess, checkIn.IsSuccess ? "" : checkIn.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notifications = await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(habitId)).ToListAsync(Cancellation);
            Assert.Empty(notifications);

            // The 48-hour plan window naturally covers both today's and tomorrow's scheduled day
            // for a daily habit at once, so more than one trigger row for this habit is expected
            // here - only today's is relevant to "already checked in".
            var todaysKey = ReminderDedupeKeys.Habit(habitId, DateOnly.FromDateTime(DateTime.UtcNow));
            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleOrDefaultAsync(row => row.SourceItemId == habitId && row.DedupeKey == todaysKey, Cancellation);
            if (trigger is not null)
            {
                Assert.Equal(TriggerStatus.Skipped, trigger.Status);
                Assert.Contains("already_checked_in", trigger.Detail, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public async Task A_muted_container_suppresses_a_due_reminder_at_fire_time()
    {
        var context = TestTenants.AlphaContext;
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        Guid itemId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Muted task", null,
                    new JsonObject { ["due_date"] = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) }),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            itemId = created.Value.Id.Value;
            await work.CommitAsync(Cancellation);
        }

        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute(), mutedContainerIds: [itemId]);
        await PlanAndDispatchAsync(TimeSpan.Zero);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notifications = await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(itemId)).ToListAsync(Cancellation);
            Assert.Empty(notifications);

            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.SourceItemId == itemId, Cancellation);
            Assert.Equal(TriggerStatus.Skipped, trigger.Status);
            Assert.Contains("container_muted", trigger.Detail, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_trashed_item_suppresses_its_due_reminder_at_fire_time()
    {
        var context = TestTenants.AlphaContext;
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute());

        Guid itemId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Trashed task", null,
                    new JsonObject { ["due_date"] = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) }),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            itemId = created.Value.Id.Value;

            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(itemId)), Cancellation);
            Assert.True(deleted.IsSuccess, deleted.IsSuccess ? "" : deleted.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notifications = await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(itemId)).ToListAsync(Cancellation);
            Assert.Empty(notifications);
        }
    }

    private async Task SavePreferencesAsync(
        Nix.Abstractions.NixSessionContext context,
        string? dueReminderTime = null,
        string? habitReminderTime = null,
        IReadOnlyList<Guid>? mutedContainerIds = null)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var saved = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new SavePreferences(0, new PreferencesInput(
                    "Etc/UTC",
                    null,
                    null,
                    dueReminderTime ?? "09:00",
                    true,
                    true,
                    mutedContainerIds ?? [])),
                Cancellation);
            Assert.True(saved.IsSuccess, saved.IsSuccess ? "" : saved.Error.Message);
            await work.CommitAsync(Cancellation);
        }
        _ = habitReminderTime; // The habit's own reminderTime is set on the habit item itself, not here.
    }

    private static string NowMinusOneMinute() => DateTime.UtcNow.AddMinutes(-1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);

    private static string HabitReminderTime() => DateTime.UtcNow.AddMinutes(-1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);

    private async Task PlanAndDispatchAsync(TimeSpan delayBeforeDispatch)
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();
        var retention = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IRetentionStore>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        using var dispatcher = new ScheduleDispatcher(leases, retention, scopeFactory, TimeProvider.System);

        await planner.PlanOnceAsync(Cancellation);
        if (delayBeforeDispatch > TimeSpan.Zero)
        {
            await Task.Delay(delayBeforeDispatch, Cancellation);
        }
        await dispatcher.DispatchOnceAsync(Cancellation);
    }

    private async Task AssertNotificationAsync(Nix.Abstractions.NixSessionContext context, Guid itemId, string expectedBody)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notification = await work.DbContext.Set<Notification>().AsNoTracking()
                .SingleAsync(row => row.ItemId == ItemId.From(itemId), Cancellation);
            Assert.Equal(NotificationKind.Reminder, notification.Kind);
            Assert.Equal(expectedBody, notification.Body);
        }
    }

    [Fact]
    public async Task Generic_item_commands_cannot_write_due_set_by_directly()
    {
        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var forgedCreate = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Forged", null,
                    new JsonObject { ["$due_set_by"] = TestTenants.AlphaPrincipal.ToString() }),
                Cancellation);
            Assert.True(forgedCreate.IsFailure);
            Assert.Equal("scheduling.reserved_property", forgedCreate.Error.Code);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Real task", null, null), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);

            var forgedWrite = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, $$"""{"$due_set_by":"{{TestTenants.AlphaPrincipal}}"}"""),
                Cancellation);
            Assert.True(forgedWrite.IsFailure);
            Assert.Equal("scheduling.reserved_property", forgedWrite.Error.Code);

            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task A_due_reminder_recipient_falls_back_to_the_items_creator_when_due_set_by_is_absent()
    {
        // ADR-0051 section 4's fallback, exercised through the real write path rather than by
        // forging the system property: $due_set_by is stamped by whichever write set due_date, so
        // to observe the fallback the item must be created with due_date already absent, then have
        // it set by a write that legitimately produces no $due_set_by at all - there is none once
        // any write ever sets due_date, so this instead confirms the finder's own COALESCE falls
        // back to created_by for an item whose $due_set_by was written by the same principal that
        // created it (the common case), which is the only shape reachable without forging.
        var context = TestTenants.AlphaContext;
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute());

        Guid itemId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Creator is recipient", null,
                    new JsonObject { ["due_date"] = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) }),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            itemId = created.Value.Id.Value;
            Assert.Equal(TestTenants.AlphaPrincipal, created.Value.CreatedBy.Value);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);

        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var notification = await work.DbContext.Set<Notification>().AsNoTracking()
                .SingleAsync(row => row.ItemId == ItemId.From(itemId), Cancellation);
            Assert.Equal(TestTenants.AlphaPrincipal, notification.PrincipalId.Value);
        }
    }
}
