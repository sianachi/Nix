using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Features.Automations;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Scheduling;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// ADR-0051 section 6 and Amendment 4 (lane C1) against real Postgres: rules plan, fire and act as
/// their owner; the property feed runs in the writer's transaction; and the loop and blast-radius
/// guards hold.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class AutomationIntegrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    internal static readonly Guid Colleague = new("1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext Alpha => TestTenants.AlphaContext;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsMigratorAsync("""
            DELETE FROM scheduled_trigger;
            DELETE FROM notification;
            DELETE FROM automation_rule;
            DELETE FROM principal_preferences;
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_schedule_rule_plans_fires_and_notifies_its_owner()
    {
        var now = DateTime.UtcNow.AddMinutes(-1);
        var ruleId = await CreateRuleAsync(Alpha, "Daily note", $$"""
            {"type":"schedule","freq":"daily","interval":1,"time":"{{now:HH:mm}}","timeZone":"Etc/UTC",
             "startDate":"{{now.AddDays(-2):yyyy-MM-dd}}"}
            """, """[{"type":"notify","title":"Daily {date}","body":"Plan the day"}]""");

        // Planned inline at creation; the planner's own pass must not add a second trigger.
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending' AND fire_at <= now() + interval '5 seconds'"));
        await PlanAsync();
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND fire_at <= now() + interval '5 seconds'"));

        await DispatchAllAsync();

        var notification = await SingleNotificationAsync(Alpha, "Daily ");
        Assert.Equal(NotificationKind.Automation, notification.Kind);
        Assert.Equal($"Daily {DateTime.UtcNow:yyyy-MM-dd}", notification.Title);
        Assert.Equal(["succeeded|schedule|0"], await RunsAsync(ruleId));
    }

    [Fact]
    public async Task A_date_rule_fires_offset_before_due_and_replans_when_the_date_moves()
    {
        var due = DateTime.UtcNow.AddMinutes(59);
        var itemId = await CreateItemAsync(Alpha, "Report", new JsonObject { ["due_date"] = due.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var ruleId = await CreateRuleAsync(Alpha, "Heads up", $$"""
            {"type":"date_arrives","key":"due_date","offsetMinutes":-60,"time":"{{due:HH:mm}}"}
            """, """[{"type":"notify","title":"Due soon: {item.title}"}]""");
        await SavePreferencesAsync(Alpha);

        await PlanAsync();
        var firstKey = await TextAsync($"SELECT dedupe_key FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'");
        Assert.NotNull(firstKey);
        await DispatchAllAsync();
        Assert.Empty(await RunsAsync(ruleId));

        // Moving the date replans: the old instant is cancelled and the new one fires an hour
        // before the new due time.
        await SetAsync(Alpha, itemId, $$"""{"due_date":"{{due:yyyy-MM-dd}}"}""");
        await PlanAsync();
        Assert.Equal("cancelled", await TextAsync($"SELECT status FROM scheduled_trigger WHERE dedupe_key = '{firstKey}'"));
        await DispatchAllAsync();

        Assert.Equal(["succeeded|date|0"], await RunsAsync(ruleId));
        Assert.Equal("Due soon: Report", (await SingleNotificationAsync(Alpha, "Due soon")).Title);
    }

    [Fact]
    public async Task A_property_change_enqueues_in_the_same_transaction_and_sets_the_target_property()
    {
        var itemId = await CreateItemAsync(Alpha, "Task", null);
        var ruleId = await CreateRuleAsync(Alpha, "Stamp done", """{"type":"property_changed","key":"status","to":{"value":"done"}}""",
            """[{"type":"set_property","target":"triggering_item","key":"closed","value":true}]""");

        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), """{"status":"done"}"""), Cancellation);
            Assert.True(written.IsSuccess);

            // Visible inside the writer's own transaction, before it commits.
            var pending = await work.DbContext.Set<Nix.Domain.Scheduling.ScheduledTrigger>().AsNoTracking()
                .Where(row => row.RuleId == ruleId).ToListAsync(Cancellation);
            var trigger = Assert.Single(pending);
            Assert.Equal("automation.property", trigger.Source);
            Assert.Equal(itemId, trigger.SourceItemId);
            Assert.StartsWith($"auto:{ruleId:D}:p0:{itemId:D}:", trigger.DedupeKey, StringComparison.Ordinal);
            await work.CommitAsync(Cancellation);
        }

        await DispatchAllAsync();

        Assert.Equal("true", await PropertyAsync(itemId, "closed"));
        Assert.Equal(["succeeded|property|0"], await RunsAsync(ruleId));
    }

    [Fact]
    public async Task A_rolled_back_property_write_enqueues_nothing()
    {
        var itemId = await CreateItemAsync(Alpha, "Task", null);
        await CreateRuleAsync(Alpha, "Watch", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"Changed"}]""");

        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), """{"status":"doing"}"""), Cancellation);
            Assert.True(written.IsSuccess);

            // Disposed without committing.
        }

        Assert.Equal(0, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'automation.property'"));
    }

    [Fact]
    public async Task Changes_outside_scope_or_on_template_items_enqueue_nothing()
    {
        var scope = await CreateItemAsync(Alpha, "Project", null);
        var inside = await CreateItemAsync(Alpha, "Inside", null, scope);
        var outside = await CreateItemAsync(Alpha, "Outside", null);
        var scoped = await CreateRuleAsync(Alpha, "Scoped", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Changed"}]""", scopeItemId: scope);

        await SetAsync(Alpha, outside, """{"status":"x"}""");
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{scoped}'"));
        await SetAsync(Alpha, inside, """{"status":"x"}""");
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{scoped}'"));

        // A template-owned row never feeds a rule, even a workspace-wide one.
        var workspaceWide = await CreateRuleAsync(Alpha, "Everywhere", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Changed"}]""");
        var templated = await CreateItemAsync(Alpha, "Template row", null);
        await ExecuteAsMigratorAsync($"""
            UPDATE item SET template_id = '{M0SchemaSeed.Alpha.TemplateId}', template_source_id = gen_random_uuid() WHERE id = '{templated}';
            UPDATE item SET properties = properties || jsonb_build_object('status', 'y') WHERE id = '{templated}';
            """);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{workspaceWide}'"));
    }

    [Fact]
    public async Task A_three_rule_chain_stops_after_depth_one()
    {
        var itemId = await CreateItemAsync(Alpha, "Chain", null);
        var first = await CreateRuleAsync(Alpha, "A", """{"type":"property_changed","key":"k1"}""",
            """[{"type":"set_property","target":"triggering_item","key":"k2","value":"from-a"}]""");
        var second = await CreateRuleAsync(Alpha, "B", """{"type":"property_changed","key":"k2"}""",
            """[{"type":"set_property","target":"triggering_item","key":"k3","value":"from-b"}]""");
        var third = await CreateRuleAsync(Alpha, "C", """{"type":"property_changed","key":"k3"}""",
            """[{"type":"set_property","target":"triggering_item","key":"k4","value":"from-c"}]""");

        await SetAsync(Alpha, itemId, """{"k1":"human"}""");
        await DispatchAllAsync();

        Assert.Equal("\"from-a\"", await PropertyAsync(itemId, "k2"));
        Assert.Equal("\"from-b\"", await PropertyAsync(itemId, "k3"));
        Assert.Null(await PropertyAsync(itemId, "k4"));
        Assert.Equal(["succeeded|property|0"], await RunsAsync(first));
        Assert.Equal(["succeeded|property|1"], await RunsAsync(second));
        Assert.Equal(["suppressed|property|2"], await RunsAsync(third));
        Assert.Contains("chain_depth", await TextAsync($"SELECT detail::text FROM automation_run WHERE rule_id = '{third}'"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_rule_setting_its_own_watched_value_is_a_noop_and_does_not_refire()
    {
        var itemId = await CreateItemAsync(Alpha, "Self", null);
        var equal = await CreateRuleAsync(Alpha, "Keep done", """{"type":"property_changed","key":"status","to":{"value":"done"}}""",
            """[{"type":"set_property","target":"triggering_item","key":"status","value":"done"}]""");
        await SetAsync(Alpha, itemId, """{"status":"done"}""");
        await DispatchAllAsync();
        Assert.Equal(["noop|property|0"], await RunsAsync(equal));

        // A rule rewriting its own watched key sees its own write come back as "no change".
        var rewrite = await CreateRuleAsync(Alpha, "Escalate", """{"type":"property_changed","key":"priority"}""",
            """[{"type":"set_property","target":"triggering_item","key":"priority","value":"high"}]""");
        await SetAsync(Alpha, itemId, """{"priority":"low"}""");
        await DispatchAllAsync();
        await DispatchAllAsync();

        Assert.Equal("\"high\"", await PropertyAsync(itemId, "priority"));
        Assert.Equal(["succeeded|property|0", "skipped|property|1"], await RunsAsync(rewrite));
        Assert.Contains("no_change", await TextAsync($"SELECT detail::text FROM automation_run WHERE rule_id = '{rewrite}' AND status = 'skipped'"), StringComparison.Ordinal);
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE status IN ('pending', 'leased')"));
    }

    [Fact]
    public async Task A_redelivered_trigger_records_one_run()
    {
        var itemId = await CreateItemAsync(Alpha, "Twice", null);
        var ruleId = await CreateRuleAsync(Alpha, "Once", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Changed {item.title}"}]""");
        await SetAsync(Alpha, itemId, """{"status":"a"}""");
        await DispatchAllAsync();

        // Redelivery: the same trigger row becomes due again.
        await ExecuteAsMigratorAsync($"UPDATE scheduled_trigger SET status = 'pending', attempts = 0, detail = NULL WHERE rule_id = '{ruleId}'");
        await DispatchAllAsync();

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
        Assert.Contains("duplicate", await TextAsync($"SELECT detail::text FROM scheduled_trigger WHERE rule_id = '{ruleId}'"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rules_throttle_at_200_per_hour_and_once_per_item_per_minute()
    {
        var first = await CreateItemAsync(Alpha, "First", null);
        var second = await CreateItemAsync(Alpha, "Second", null);
        var ruleId = await CreateRuleAsync(Alpha, "Busy", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Changed"}]""");
        await SetAsync(Alpha, first, """{"status":"a"}""");
        await DispatchAllAsync();

        // The same item again inside the minute.
        var again = await RunNowAsync(Alpha, ruleId, first);
        Assert.Equal("throttled", again.Status);

        // A different item, but the rule already ran 200 times this hour.
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'bulk:' || n, 'manual', 0, 'succeeded', now() - interval '10 minutes'
              FROM generate_series(1, 200) n;
            """);
        var busy = await RunNowAsync(Alpha, ruleId, second);
        Assert.Equal("throttled", busy.Status);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
    }

    [Fact]
    public async Task An_owner_without_write_access_fails_closed_and_five_failures_disable_the_rule()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var items = new List<Guid>();
        for (var index = 0; index < 5; index++)
        {
            items.Add(await CreateItemAsync(Alpha, $"Item {index}", null));
        }

        var ruleId = await CreateRuleAsync(colleague, "Flagger", """{"type":"property_changed","key":"status"}""",
            """[{"type":"set_property","target":"triggering_item","key":"flag","value":true}]""");
        await ExecuteAsMigratorAsync($"UPDATE workspace_member SET role = 'viewer' WHERE subject_id = '{Colleague}'");

        foreach (var item in items)
        {
            var run = await RunNowAsync(colleague, ruleId, item);
            Assert.Equal("failed", run.Status);
        }

        foreach (var item in items)
        {
            Assert.Null(await PropertyAsync(item, "flag"));
        }

        Assert.Equal("false|repeated_failures|5", await TextAsync(
            $"SELECT enabled::text || '|' || disabled_reason || '|' || consecutive_failures FROM automation_rule WHERE id = '{ruleId}'"));
        var notice = await SingleNotificationAsync(colleague, "Automation turned off");
        Assert.Contains("Flagger", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Disabling_a_rule_cancels_pending_triggers_and_a_leased_one_is_skipped()
    {
        var now = DateTime.UtcNow.AddMinutes(-1);
        var trigger = $$"""{"type":"schedule","freq":"daily","interval":1,"time":"{{now:HH:mm}}","timeZone":"Etc/UTC","startDate":"{{now.AddDays(-2):yyyy-MM-dd}}"}""";
        const string actions = """[{"type":"notify","title":"Tick"}]""";
        var ruleId = await CreateRuleAsync(Alpha, "Ticker", trigger, actions);
        Assert.True(await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'") >= 2);

        // Lease the due one as another replica would, then disable the rule.
        await PullDueForwardAsync();
        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            var leased = await scope.ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>()
                .LeaseDueAsync(10, "other-replica", 60, 5, Cancellation);
            Assert.Single(leased);
        }

        var saved = await UpdateRuleAsync(Alpha, ruleId, 1, "Ticker", trigger, actions, enabled: false);
        Assert.False(saved.Enabled);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'"));

        // The other replica died; its lease expires and this one picks the row up.
        await ExecuteAsMigratorAsync($"UPDATE scheduled_trigger SET lease_until = now() - interval '1 second' WHERE rule_id = '{ruleId}' AND status = 'leased'");
        await DispatchAllAsync();

        Assert.Contains("rule_disabled", await TextAsync($"SELECT detail::text FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'skipped'"), StringComparison.Ordinal);
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
    }

    [Fact]
    public async Task Run_now_is_owner_only_and_test_writes_nothing()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var itemId = await CreateItemAsync(Alpha, "Target", null);
        var ruleId = await CreateRuleAsync(Alpha, "Mine", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Hello {item.title}"},{"type":"set_property","target":"triggering_item","key":"seen","value":1}]""");

        var work = await fixture.Application.BeginUnitOfWorkAsync(colleague, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var run = await dispatcher.SendAsync<RunAutomation, AutomationRunResponse>(new(ruleId, itemId), Cancellation);
            Assert.Equal(AutomationErrors.NotFoundCode, run.Error.Code);
            var test = await dispatcher.SendAsync<TestAutomation, AutomationTestResponse>(new(ruleId, itemId), Cancellation);
            Assert.Equal(AutomationErrors.NotFoundCode, test.Error.Code);
        }

        AutomationTestResponse preview;
        work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var test = await work.Resolve<NixDispatcher>().SendAsync<TestAutomation, AutomationTestResponse>(new(ruleId, itemId), Cancellation);
            Assert.True(test.IsSuccess);
            preview = test.Value;
            await work.CommitAsync(Cancellation);
        }

        Assert.True(preview.WouldRun);
        Assert.Equal("Hello Target", preview.Actions[0].Title);
        Assert.Equal(itemId, preview.Actions[1].ItemId);
        Assert.Empty(await RunsAsync(ruleId));
        Assert.Null(await PropertyAsync(itemId, "seen"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));

        var ran = await RunNowAsync(Alpha, ruleId, itemId);
        Assert.Equal("succeeded", ran.Status);
        Assert.Equal("manual", ran.Origin);
        Assert.Equal("1", await PropertyAsync(itemId, "seen"));
    }

    [Fact]
    public async Task Runs_are_trimmed_to_500_per_rule_and_purged_after_30_days()
    {
        var itemId = await CreateItemAsync(Alpha, "Target", null);
        var ruleId = await CreateRuleAsync(Alpha, "Chatty", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"Hi"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'old:' || n, 'manual', 0, 'skipped', now() - interval '2 hours' - n * interval '1 second'
              FROM generate_series(1, 505) n;
            """);

        var run = await RunNowAsync(Alpha, ruleId, itemId);
        Assert.Equal("succeeded", run.Status);
        Assert.Equal(500, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND id = '{run.Id}'"));

        await ExecuteAsMigratorAsync($"""
            UPDATE automation_run SET created_at = now() - interval '31 days'
             WHERE id IN (SELECT id FROM automation_run WHERE rule_id = '{ruleId}' AND trigger_key LIKE 'old:%' LIMIT 10);
            """);
        await using var scope = fixture.Application.CreateUnscopedScope();
        var purged = await scope.ServiceProvider.GetRequiredService<IRetentionStore>().PurgeAutomationRunsAsync(500, Cancellation);
        Assert.Equal(10, purged);
        Assert.Equal(490, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
    }

    [Fact]
    public async Task The_planner_does_not_log_incomplete_plan_warnings_for_the_event_fed_property_source()
    {
        var itemId = await CreateItemAsync(Alpha, "Target", null);
        await CreateRuleAsync(Alpha, "Watch", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"Hi"}]""");
        await SetAsync(Alpha, itemId, """{"status":"a"}""");

        var logger = new CapturingLogger<TriggerPlanner>();
        await PlanAsync(logger);

        Assert.DoesNotContain(logger.Events, entry => entry.EventId.Id is 5311 or 5312);
        Assert.DoesNotContain(logger.Events, entry => entry.Message.Contains("automation.property", StringComparison.Ordinal));

        // Planning neither cancelled nor rewrote the event-fed row.
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'automation.property' AND status = 'pending'"));
    }

    internal static AutomationRuleInput Input(string name, string trigger, string actions, string? conditions = null, Guid? scopeItemId = null, bool enabled = true) =>
        new(name, enabled, scopeItemId, JsonNode.Parse(trigger)!.AsObject(), conditions is null ? null : JsonNode.Parse(conditions)!.AsArray(), JsonNode.Parse(actions)!.AsArray());

    private async Task<Guid> CreateRuleAsync(NixSessionContext context, string name, string trigger, string actions, Guid? scopeItemId = null)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(context.WorkspaceId!.Value, Input(name, trigger, actions, scopeItemId: scopeItemId)), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
            return created.Value.Id;
        }
    }

    private async Task<AutomationRuleResponse> UpdateRuleAsync(NixSessionContext context, Guid ruleId, long revision, string name, string trigger, string actions, bool enabled)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<UpdateAutomation, AutomationRuleResponse>(
                new(ruleId, revision, Input(name, trigger, actions, enabled: enabled)), Cancellation);
            Assert.True(saved.IsSuccess, saved.IsSuccess ? "" : saved.Error.Message);
            await work.CommitAsync(Cancellation);
            return saved.Value;
        }
    }

    private async Task<AutomationRunResponse> RunNowAsync(NixSessionContext context, Guid ruleId, Guid? itemId)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var run = await work.Resolve<NixDispatcher>().SendAsync<RunAutomation, AutomationRunResponse>(new(ruleId, itemId), Cancellation);
            Assert.True(run.IsSuccess, run.IsSuccess ? "" : run.Error.Message);
            await work.CommitAsync(Cancellation);
            return run.Value;
        }
    }

    private async Task<Guid> CreateItemAsync(NixSessionContext context, string title, JsonObject? properties, Guid? parent = null)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "task", title, parent is { } id ? ItemId.From(id) : null, properties), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
            return created.Value.Id.Value;
        }
    }

    private async Task SetAsync(NixSessionContext context, Guid itemId, string changes)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), changes), Cancellation);
            Assert.True(written.IsSuccess, written.IsSuccess ? "" : written.Error.Message);
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task SavePreferencesAsync(NixSessionContext context)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<Nix.Features.Notifications.SavePreferences, Nix.Features.Notifications.PrincipalPreferencesResponse>(
                new(0, new Nix.Features.Notifications.PreferencesInput("Etc/UTC", null, null, "09:00", true, true, [])), Cancellation);
            Assert.True(saved.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task PlanAsync(ILogger<TriggerPlanner>? logger = null)
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        using var planner = new TriggerPlanner(scope.ServiceProvider.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System, logger);
        await planner.PlanOnceAsync(Cancellation);
    }

    private async Task DispatchAllAsync()
    {
        // A trigger clamped to the host's "now" (an overdue occurrence, a property change) is due;
        // anything due within a few seconds is pulled back so a container clock trailing the
        // host's cannot make it look early.
        await PullDueForwardAsync();
        await using var scope = fixture.Application.CreateUnscopedScope();
        var provider = scope.ServiceProvider;
        using var dispatcher = new ScheduleDispatcher(
            provider.GetRequiredService<IScheduledTriggerLeaseStore>(),
            provider.GetRequiredService<IRetentionStore>(),
            provider.GetRequiredService<IServiceScopeFactory>(),
            TimeProvider.System);
        for (var pass = 0; pass < 10 && await dispatcher.DispatchOnceAsync(Cancellation) > 0; pass++)
        {
        }
    }

    private Task PullDueForwardAsync() => ExecuteAsMigratorAsync(
        "UPDATE scheduled_trigger SET fire_at = now() - interval '1 second' WHERE status = 'pending' AND fire_at <= now() + interval '5 seconds'");

    private async Task<Notification> SingleNotificationAsync(NixSessionContext context, string titlePrefix)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.Kind == NotificationKind.Automation).ToListAsync(Cancellation);
            return Assert.Single(rows, row => row.Title.StartsWith(titlePrefix, StringComparison.Ordinal));
        }
    }

    private async Task<IReadOnlyList<string>> RunsAsync(Guid ruleId)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextListAsync(connection, $"""
                SELECT status || '|' || origin || '|' || depth FROM automation_run
                 WHERE rule_id = '{ruleId}' ORDER BY created_at, depth
                """);
        }
    }

    private async Task<string?> PropertyAsync(Guid itemId, string key) =>
        await TextAsync($"SELECT (properties -> '{key}')::text FROM item WHERE id = '{itemId}'");

    private async Task<string?> TextAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(connection, transaction: null, sql);
        }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null, sql);
        }
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private Task SeedColleagueAsync(string role) => ExecuteAsMigratorAsync($"""
        INSERT INTO principal
            (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
        VALUES ('{Colleague}', '{TestTenants.Alpha}', 'alpha-automation-colleague', 'user', 'Colleague',
                'automation-colleague@example.test', 'active', NULL);

        INSERT INTO workspace_member
            (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Colleague}', '{TestTenants.Alpha}', '{role}',
                '{TestTenants.AlphaPrincipal}', now());
        """);
}

/// <summary>Collects log entries so a test can assert what was (and was not) logged.</summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, EventId EventId, string Message)> Events { get; } = [];

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        ArgumentNullException.ThrowIfNull(formatter);
        lock (Events)
        {
            Events.Add((logLevel, eventId, formatter(state, exception)));
        }
    }
}
