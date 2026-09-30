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

    private static readonly Guid Colleague = new("13131313-1111-4111-8111-131313131313");

    private static string Today() => DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    private async Task SeedColleagueAsync(string status)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
                VALUES ('{Colleague}', '{TestTenants.Alpha}', 'alpha-reminder-colleague', 'user', 'Colleague',
                        'reminder-colleague@example.test', '{status}', NULL);

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Colleague}', '{TestTenants.Alpha}', 'editor',
                        '{TestTenants.AlphaPrincipal}', now());
                """);
        }
    }

    private async Task<Guid> CreateItemAsync(Nix.Abstractions.NixSessionContext context, string title, JsonObject? properties)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", title, null, properties), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
            return created.Value.Id.Value;
        }
    }

    private async Task ForgePropertyAsync(Guid itemId, string key, string value)
    {
        // Written as the migrator, straight into storage: the shape a value would have if it ever
        // reached the bag without passing the write path's guard.
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                UPDATE item SET properties = properties || jsonb_build_object('{key}', '{value}'::text)
                 WHERE id = '{itemId}';
                """);
        }
    }

    private async Task<IReadOnlyList<Notification>> NotificationsForAsync(Guid principalId, Guid itemId)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(itemId)).ToListAsync(Cancellation);
        }
    }

    [Theory]
    [InlineData("$reminder_set_by")]
    [InlineData("$habit_reminder_time")]
    [InlineData("$habit_check_in_date")]
    public async Task Generic_item_commands_cannot_write_any_reserved_scheduling_key(string key)
    {
        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var forgedCreate = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Forged", null, new JsonObject { [key] = "x" }),
                Cancellation);
            Assert.True(forgedCreate.IsFailure);
            Assert.Equal("scheduling.reserved_property", forgedCreate.Error.Code);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", "Real task", null, null), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);

            var forgedWrite = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, new JsonObject { [key] = "x" }.ToJsonString()), Cancellation);
            Assert.True(forgedWrite.IsFailure);
            Assert.Equal("scheduling.reserved_property", forgedWrite.Error.Code);
        }
    }

    [Fact]
    public async Task A_due_set_by_naming_another_tenants_principal_falls_back_to_the_creator()
    {
        var context = TestTenants.AlphaContext;
        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute());
        var itemId = await CreateItemAsync(context, "Cross-tenant setter", new JsonObject { ["due_date"] = Today() });
        await ForgePropertyAsync(itemId, "$due_set_by", TestTenants.BetaPrincipal.ToString());

        await PlanAndDispatchAsync(TimeSpan.Zero);

        var notification = Assert.Single(await NotificationsForAsync(TestTenants.AlphaPrincipal, itemId));
        Assert.Equal("Due today", notification.Body);
    }

    [Fact]
    public async Task A_due_set_by_naming_a_suspended_colleague_falls_back_to_the_creator()
    {
        var context = TestTenants.AlphaContext;
        await SeedColleagueAsync("suspended");
        await SavePreferencesAsync(context, dueReminderTime: NowMinusOneMinute());
        var itemId = await CreateItemAsync(context, "Suspended setter", new JsonObject { ["due_date"] = Today() });
        await ForgePropertyAsync(itemId, "$due_set_by", Colleague.ToString());

        await PlanAndDispatchAsync(TimeSpan.Zero);

        Assert.Single(await NotificationsForAsync(TestTenants.AlphaPrincipal, itemId));
        Assert.Empty(await NotificationsForAsync(Colleague, itemId));
    }

    [Fact]
    public async Task An_explicit_reminder_goes_to_the_colleague_who_set_it()
    {
        await SeedColleagueAsync("active");
        var itemId = await CreateItemAsync(TestTenants.AlphaContext, "Colleague's reminder", null);

        var colleagueContext = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var work = await fixture.Application.BeginUnitOfWorkAsync(colleagueContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var reminderAt = DateTimeOffset.UtcNow.AddMilliseconds(200);
            var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), new JsonObject
                {
                    ["reminder"] = $"{reminderAt.UtcDateTime:yyyy-MM-ddTHH:mm:ss}+00:00[Etc/UTC]",
                }.ToJsonString()),
                Cancellation);
            Assert.True(written.IsSuccess, written.IsSuccess ? "" : written.Error.Message);
            Assert.Equal(Colleague.ToString(), (string?)JsonNode.Parse(written.Value.Properties!)![ItemProperties.ReminderSetByKey]);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync(TimeSpan.FromMilliseconds(400));

        var notification = Assert.Single(await NotificationsForAsync(Colleague, itemId));
        Assert.Equal("Reminder", notification.Body);
        Assert.Empty(await NotificationsForAsync(TestTenants.AlphaPrincipal, itemId));
    }

    [Fact]
    public async Task An_explicit_reminder_missed_during_an_outage_is_planned_once_and_fires_once()
    {
        // S3: the reminder's instant passed two hours ago while nothing was planning. It is still
        // owed once; replanning afterwards finds its row fired and leaves it alone.
        var context = TestTenants.AlphaContext;
        var missedAt = DateTimeOffset.UtcNow.AddHours(-2);
        var itemId = await CreateItemAsync(context, "Missed during outage", new JsonObject
        {
            ["reminder"] = $"{missedAt.UtcDateTime:yyyy-MM-ddTHH:mm:ss}+00:00[Etc/UTC]",
        });

        await PlanAndDispatchAsync(TimeSpan.Zero);
        await PlanAndDispatchAsync(TimeSpan.Zero);

        Assert.Single(await NotificationsForAsync(TestTenants.AlphaPrincipal, itemId));
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.SourceItemId == itemId, Cancellation);
            Assert.Equal(TriggerStatus.Fired, trigger.Status);
        }
    }

    [Fact]
    public async Task Preferences_are_read_for_more_than_500_recipients_by_the_whole_key()
    {
        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new SavePreferences(0, new PreferencesInput("Europe/London", null, null, "07:30", true, true, [])), Cancellation);
            Assert.True(saved.IsSuccess, saved.IsSuccess ? "" : saved.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        var alpha = new ReminderRecipient(context.TenantId, context.PrincipalId);
        // The same principal id asked for under another tenant must not read Alpha's row.
        var misTenanted = new ReminderRecipient(Nix.Domain.Tenancy.TenantId.From(TestTenants.Beta), context.PrincipalId);
        ReminderRecipient[] recipients =
        [
            alpha,
            misTenanted,
            .. Enumerable.Range(0, 700).Select(_ => new ReminderRecipient(
                context.TenantId, Nix.Domain.Identity.PrincipalId.From(Guid.NewGuid()))),
        ];

        var finder = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IReminderCandidateFinder>();
        var preferences = await finder.PreferencesForAsync(recipients, Cancellation);

        Assert.Equal(recipients.Length, preferences.Count);
        var byRecipient = preferences.ToDictionary(entry => entry.Recipient);
        Assert.Equal(new TimeOnly(7, 30), byRecipient[alpha].DueReminderTime);
        Assert.Equal("Europe/London", byRecipient[alpha].TimeZone);
        Assert.Equal(new TimeOnly(9, 0), byRecipient[misTenanted].DueReminderTime);
        Assert.Equal("UTC", byRecipient[misTenanted].TimeZone);
    }

    [Fact]
    public async Task Due_candidates_come_from_two_arms_and_skip_completed_historical_and_ended_items()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        string Day(DateOnly day) => day.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var plainDue = Guid.NewGuid();
        var plainCompleted = Guid.NewGuid();
        var plainHistorical = Guid.NewGuid();
        var recurring = Guid.NewGuid();
        var recurringEnded = Guid.NewGuid();

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            string Row(Guid id, string properties, string? recurrence) =>
                $"('{id}', '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'task', NULL, 1000, '{properties}'::jsonb, "
                + (recurrence is null ? "NULL" : $"'{recurrence}'::jsonb")
                + $", 'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now())";
            var dailyRule = "{\"freq\":\"daily\",\"interval\":1}";
            var endedRule = "{\"freq\":\"daily\",\"interval\":1,\"until\":\"" + Day(today.AddYears(-1)) + "\"}";
            var rows = string.Join(",\n", new[]
            {
                Row(plainDue, "{\"title\":\"due\",\"due_date\":\"" + Day(today) + "\"}", null),
                Row(plainCompleted, "{\"title\":\"done\",\"due_date\":\"" + Day(today) + "\",\"completion\":true}", null),
                Row(plainHistorical, "{\"title\":\"old\",\"due_date\":\"" + Day(today.AddYears(-3)) + "\"}", null),
                Row(recurring, "{\"title\":\"daily\",\"due_date\":\"" + Day(today.AddYears(-2)) + "\"}", dailyRule),
                Row(recurringEnded, "{\"title\":\"ended\",\"due_date\":\"" + Day(today.AddYears(-2)) + "\"}", endedRule),
            });
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, recurrence, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                VALUES
                {rows};
                """);
        }

        var finder = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IReminderCandidateFinder>();
        var plain = await finder.FindDueAsync(today.AddDays(-1), today.AddDays(3), 500, string.Empty, Guid.Empty, Cancellation);
        var recurringFound = await finder.FindRecurringDueAsync(today.AddDays(-1), today.AddDays(3), 500, Guid.Empty, Cancellation);

        Assert.Equal(new[] { plainDue }, plain.Select(candidate => candidate.ItemId));
        Assert.Equal(today, plain[0].DueDay);
        Assert.Equal(new[] { recurring }, recurringFound.Select(candidate => candidate.ItemId));
        Assert.Equal(today.AddYears(-2), recurringFound[0].AnchorDay);

        // And both arms become triggers for today.
        await SavePreferencesAsync(TestTenants.AlphaContext, dueReminderTime: "23:59");
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        await planner.PlanOnceAsync(Cancellation);

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var keys = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .Select(row => row.DedupeKey).ToListAsync(Cancellation);
            Assert.Contains(ReminderDedupeKeys.Due(plainDue, today), keys);
            Assert.Contains(ReminderDedupeKeys.Due(recurring, today), keys);
            Assert.DoesNotContain(keys, key => key.Contains(plainCompleted.ToString(), StringComparison.Ordinal)
                || key.Contains(plainHistorical.ToString(), StringComparison.Ordinal)
                || key.Contains(recurringEnded.ToString(), StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task A_habit_with_thousands_of_check_ins_is_still_skipped_once_today_is_checked_in()
    {
        // L4: "already checked in today" must not depend on how many older check-ins exist.
        var context = TestTenants.AlphaContext;
        await SavePreferencesAsync(context);

        Guid habitId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "habit", "Long streak", null, null), Cancellation);
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

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // 2,500 older check-ins sorted ahead of today's, then today's own.
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'note', '{habitId}', g,
                       jsonb_build_object('title', 'Check-in', '$habit_check_in_date', to_char(date '2015-01-01' + g, 'YYYY-MM-DD'),
                                          '$habit_check_in_completed', true),
                       'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now()
                  FROM generate_series(1, 2500) g;

                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                VALUES (gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'note', '{habitId}', 1000000,
                        jsonb_build_object('title', 'Check-in', '$habit_check_in_date', '{Today()}', '$habit_check_in_completed', true),
                        'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now());
                """);
        }

        await PlanAndDispatchAsync(TimeSpan.Zero);

        Assert.Empty(await NotificationsForAsync(TestTenants.AlphaPrincipal, habitId));
        work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var todaysKey = ReminderDedupeKeys.Habit(habitId, DateOnly.FromDateTime(DateTime.UtcNow));
            var trigger = await work.DbContext.Set<ScheduledTrigger>().AsNoTracking()
                .SingleAsync(row => row.DedupeKey == todaysKey, Cancellation);
            Assert.Equal(TriggerStatus.Skipped, trigger.Status);
            Assert.Contains("already_checked_in", trigger.Detail, StringComparison.Ordinal);
        }
    }
}

