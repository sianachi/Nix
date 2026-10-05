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

        // Decided in the trigger, before anything verified the owner may read the item.
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{third}' AND item_id IS NULL"));
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
                .LeaseDueAsync(10, "other-replica", 60, 5, null, Cancellation);
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

    [Fact]
    public async Task A_lock_over_the_triggering_item_keeps_it_out_of_notifications_created_items_previews_and_the_run_log()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var folder = await CreateItemAsync(Alpha, "Private folder", null);
        var diary = await CreateItemAsync(Alpha, "Secret diary", null, folder);
        var watcher = await CreateRuleAsync(Alpha, "Watch", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"Changed: {item.title}","body":"{item.title}"},{"type":"create_item","parent":"triggering_item","itemType":"task","title":"Follow up {item.title}"}]""");
        var stamper = await CreateRuleAsync(Alpha, "Stamp", """{"type":"property_changed","key":"never"}""",
            $$"""[{"type":"set_property","target":{"itemId":"{{diary}}"},"key":"stamped","value":true}]""");

        // Another member changes the item; the owner then locks the folder above it.
        await SetAsync(colleague, diary, """{"status":"written"}""");
        await LockAsync(folder);
        await DispatchAllAsync();

        // Skipped at the trigger, and no run recorded: a run row would tell the owner a covered
        // item had changed at all.
        Assert.Empty(await RunsAsync(watcher));
        Assert.Contains("item_locked", await TextAsync($"SELECT detail::text FROM scheduled_trigger WHERE rule_id = '{watcher}' AND status = 'skipped'"), StringComparison.Ordinal);
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM item WHERE properties ->> 'title' LIKE 'Follow up%'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM automation_run WHERE item_id = '{diary}'"));

        // The dry run renders nothing from the locked item either.
        AutomationTestResponse preview;
        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var test = await work.Resolve<NixDispatcher>().SendAsync<TestAutomation, AutomationTestResponse>(new(watcher, diary), Cancellation);
            Assert.True(test.IsSuccess);
            preview = test.Value;
        }

        Assert.False(preview.WouldRun);
        Assert.Equal("item_gone", preview.Reason);
        Assert.Empty(preview.Actions);

        // A named target under the lock refuses the action rather than writing through it.
        var stamped = await RunNowAsync(Alpha, stamper, null);
        Assert.Equal("failed", stamped.Status);
        Assert.Equal("set_property.target_locked", stamped.Reason);
        Assert.Null(await PropertyAsync(diary, "stamped"));
    }

    [Fact]
    public async Task Every_owner_keeps_its_own_fifty_rule_cap_on_one_change()
    {
        await SeedColleagueAsync("editor");
        var itemId = await CreateItemAsync(Alpha, "Shared", null);

        // Fifty rules of one owner sort before the other owner's single rule.
        await ExecuteAsMigratorAsync($$"""
            INSERT INTO automation_rule (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, watch_key,
                                         trigger, conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
            SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '{{TestTenants.Alpha}}', '{{TestTenants.AlphaWorkspace}}',
                   '{{TestTenants.AlphaPrincipal}}', 'Mine ' || n, true, 'property_changed', 'status',
                   '{"type":"property_changed","key":"status"}', '[]', '[{"type":"notify","title":"x"}]', 1, 1, 0, now(), now()
              FROM generate_series(1, 50) n;
            INSERT INTO automation_rule (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, watch_key,
                                         trigger, conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
            VALUES ('ffffffff-ffff-4fff-bfff-ffffffffffff', '{{TestTenants.Alpha}}', '{{TestTenants.AlphaWorkspace}}', '{{Colleague}}', 'Theirs',
                    true, 'property_changed', 'status', '{"type":"property_changed","key":"status"}', '[]',
                    '[{"type":"notify","title":"x"}]', 1, 1, 0, now(), now());
            """);

        await SetAsync(Alpha, itemId, """{"status":"moved"}""");

        Assert.Equal(50, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source = 'automation.property' AND principal_id = '{TestTenants.AlphaPrincipal}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source = 'automation.property' AND principal_id = '{Colleague}'"));
    }

    [Fact]
    public async Task An_owner_removed_from_the_workspace_records_access_lost_without_the_item_and_cannot_read_the_rule()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var itemId = await CreateItemAsync(Alpha, "Roadmap", null);
        var ruleId = await CreateRuleAsync(colleague, "Theirs", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"{item.title}"}]""");

        await ExecuteAsMigratorAsync($"DELETE FROM workspace_member WHERE subject_id = '{Colleague}'");
        await SetAsync(Alpha, itemId, """{"status":"moved"}""");
        await DispatchAllAsync();

        Assert.Equal(["failed|property|0"], await RunsAsync(ruleId));
        Assert.Equal("access_lost|null", await TextAsync(
            $"SELECT (detail ->> 'reason') || '|' || COALESCE(item_id::text, 'null') FROM automation_run WHERE rule_id = '{ruleId}'"));

        var work = await fixture.Application.BeginUnitOfWorkAsync(colleague, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<GetAutomation, AutomationRuleResponse>(new(ruleId), Cancellation)).Error.Code);
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<ListAutomationRuns, AutomationRunsPageResponse>(new(ruleId, null), Cancellation)).Error.Code);
        }
    }

    [Fact]
    public async Task A_suspended_owners_rule_fails_without_the_item_and_disables_after_five()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var ruleId = await CreateRuleAsync(colleague, "Theirs", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"{item.title}"}]""");
        var items = new List<Guid>();
        for (var index = 0; index < 5; index++)
        {
            items.Add(await CreateItemAsync(Alpha, $"Item {index}", null));
        }

        await ExecuteAsMigratorAsync($"UPDATE principal SET status = 'suspended' WHERE principal_id = '{Colleague}'");
        foreach (var item in items)
        {
            await SetAsync(Alpha, item, """{"status":"moved"}""");
        }

        await DispatchAllAsync();

        Assert.Equal(5, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND status = 'failed' AND detail ->> 'reason' = 'owner_inactive' AND item_id IS NULL"));
        Assert.Equal("false|repeated_failures", await TextAsync($"SELECT enabled::text || '|' || disabled_reason FROM automation_rule WHERE id = '{ruleId}'"));
    }

    [Fact]
    public async Task A_bulk_write_past_the_budget_enqueues_no_more_and_notes_each_rule_once()
    {
        var first = await CreateRuleAsync(Alpha, "One", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        var second = await CreateRuleAsync(Alpha, "Two", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'task', NULL, 100000 + n,
                   jsonb_build_object('title', 'Bulk ' || n, 'bulk', true), 'active',
                   '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now()
              FROM generate_series(1, 600) n;
            """);

        // One statement, one transaction: 600 rows times two rules would be 1,200 triggers.
        await ExecuteAsMigratorAsync("UPDATE item SET properties = properties || '{\"status\":\"done\"}' WHERE properties ? 'bulk'");

        Assert.Equal(1000, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'automation.property'"));
        foreach (var ruleId in new[] { first, second })
        {
            Assert.Equal("throttled|bulk_write|null", await TextAsync(
                $"SELECT status || '|' || (detail ->> 'reason') || '|' || COALESCE(item_id::text, 'null') FROM automation_run WHERE rule_id = '{ruleId}'"));
        }
    }

    [Fact]
    public async Task A_property_change_fires_at_the_start_of_the_next_minute()
    {
        var itemId = await CreateItemAsync(Alpha, "Edge", null);
        var ruleId = await CreateRuleAsync(Alpha, "Watch", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        await SetAsync(Alpha, itemId, """{"status":"a"}""");

        Assert.Equal("true", await TextAsync($"""
            SELECT (fire_at = date_trunc('minute', created_at) + interval '1 minute')::text
              FROM scheduled_trigger WHERE rule_id = '{ruleId}'
            """));
    }

    [Fact]
    public async Task The_hourly_cap_records_one_throttled_run_and_cancels_the_rules_queued_property_triggers()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Busy", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        var items = new List<Guid>();
        for (var index = 0; index < 5; index++)
        {
            items.Add(await CreateItemAsync(Alpha, $"Item {index}", null));
        }

        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'busy:' || n, 'manual', 0, 'succeeded', now() - interval '10 minutes'
              FROM generate_series(1, 200) n;
            """);
        foreach (var item in items)
        {
            await SetAsync(Alpha, item, """{"status":"a"}""");
        }

        // Three are due now; two are queued for later.
        await ExecuteAsMigratorAsync($"""
            UPDATE scheduled_trigger SET fire_at = now() + interval '1 hour'
             WHERE rule_id = '{ruleId}' AND source_item_id IN ('{items[3]}', '{items[4]}');
            UPDATE scheduled_trigger SET fire_at = now() - interval '1 second'
             WHERE rule_id = '{ruleId}' AND status = 'pending' AND fire_at < now() + interval '5 minutes';
            """);
        await DispatchAllAsync();

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND status = 'throttled'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND trigger_key LIKE 'auto:%:throttled:%'"));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'cancelled'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
    }

    [Fact]
    public async Task Runs_are_trimmed_to_500_on_every_recorded_run_not_only_a_successful_one()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Chatty", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"Hi"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'old:' || n, 'manual', 0, 'skipped', now() - interval '2 hours' - n * interval '1 second'
              FROM generate_series(1, 505) n;
            """);

        // The same item again inside the minute: a throttled run, which is recorded - and trimmed
        // after - like any other.
        var itemId = await CreateItemAsync(Alpha, "Target", null);
        Assert.Equal("succeeded", (await RunNowAsync(Alpha, ruleId, itemId)).Status);
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'older:' || n, 'manual', 0, 'skipped', now() - interval '3 hours' - n * interval '1 second'
              FROM generate_series(1, 20) n;
            """);
        var run = await RunNowAsync(Alpha, ruleId, itemId);
        Assert.Equal("throttled", run.Status);
        Assert.Equal(500, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
    }

    [Fact]
    public async Task One_retention_pass_drains_more_than_a_single_batch()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Old", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"Hi"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'ancient:' || n, 'manual', 0, 'skipped', now() - interval '40 days'
              FROM generate_series(1, 1200) n;
            """);

        await using var scope = fixture.Application.CreateUnscopedScope();
        var provider = scope.ServiceProvider;
        using var dispatcher = new ScheduleDispatcher(
            provider.GetRequiredService<IScheduledTriggerLeaseStore>(),
            provider.GetRequiredService<IRetentionStore>(),
            provider.GetRequiredService<IServiceScopeFactory>(),
            TimeProvider.System);
        await dispatcher.RetentionOnceIfDueAsync(Cancellation);

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
    }

    [Fact]
    public async Task A_due_reminder_is_leased_ahead_of_an_earlier_automation_backlog()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Backlog", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO scheduled_trigger (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                                           fire_at, dedupe_key, status, attempts, created_at, updated_at)
            SELECT '{TestTenants.Alpha}', gen_random_uuid(), '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaPrincipal}', 'automation',
                   'automation.property', NULL, '{ruleId}', now() - interval '10 minutes' + n * interval '1 millisecond',
                   'backlog-' || n, 'pending', 0, now(), now()
              FROM generate_series(1, 60) n;
            INSERT INTO scheduled_trigger (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                                           fire_at, dedupe_key, status, attempts, created_at, updated_at)
            VALUES ('{TestTenants.Alpha}', gen_random_uuid(), NULL, '{TestTenants.AlphaPrincipal}', 'reminder', 'reminder.due',
                    gen_random_uuid(), NULL, now() - interval '1 minute', 'due-reminder', 'pending', 0, now(), now());
            """);

        await using var scope = fixture.Application.CreateUnscopedScope();
        var provider = scope.ServiceProvider;
        using var dispatcher = new ScheduleDispatcher(
            provider.GetRequiredService<IScheduledTriggerLeaseStore>(),
            provider.GetRequiredService<IRetentionStore>(),
            provider.GetRequiredService<IServiceScopeFactory>(),
            TimeProvider.System);
        Assert.Equal(ScheduleDispatcher.BatchSize, await dispatcher.DispatchOnceAsync(Cancellation));

        Assert.NotEqual("pending", await TextAsync("SELECT status FROM scheduled_trigger WHERE dedupe_key = 'due-reminder'"));
        Assert.Equal(11, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE dedupe_key LIKE 'backlog-%' AND status = 'pending'"));
    }

    [Fact]
    public async Task A_rule_past_the_tables_size_bound_is_refused_as_invalid()
    {
        // Seven bytes as written, sixteen thousand digits as jsonb stores it: the validator's own
        // limits pass it, and the table's bound is the backstop.
        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var refused = await dispatcher.SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(Alpha.WorkspaceId!.Value, Input("Huge", """{"type":"property_changed","key":"status"}""",
                    """[{"type":"set_property","target":"triggering_item","key":"n","value":1e16500}]""")), Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal(AutomationErrors.InvalidCode, refused.Error.Code);

            // The transaction is still usable afterwards.
            var created = await dispatcher.SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(Alpha.WorkspaceId!.Value, Input("Small", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""")), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(1, await CountAsync("SELECT count(*) FROM automation_rule"));
    }

    [Fact]
    public async Task Concurrent_creates_at_the_ceiling_leave_exactly_fifty_rules()
    {
        await ExecuteAsMigratorAsync($$"""
            INSERT INTO automation_rule (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, watch_key,
                                         trigger, conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
            SELECT gen_random_uuid(), '{{TestTenants.Alpha}}', '{{TestTenants.AlphaWorkspace}}', '{{TestTenants.AlphaPrincipal}}', 'Rule ' || n,
                   true, 'property_changed', 'status', '{"type":"property_changed","key":"status"}', '[]',
                   '[{"type":"notify","title":"x"}]', 1, 1, 0, now(), now()
              FROM generate_series(1, 49) n;
            """);

        var first = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        Task<Result<AutomationRuleResponse>> racing;
        await using (first.ConfigureAwait(false))
        {
            var created = await first.Resolve<NixDispatcher>().SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(Alpha.WorkspaceId!.Value, Input("Fiftieth", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""")), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);

            // A second create starts before the first commits.
            racing = CreateInOwnUnitOfWorkAsync("Fifty-first");
            await Task.Delay(TimeSpan.FromMilliseconds(500), Cancellation);
            await first.CommitAsync(Cancellation);
        }

        var second = await racing;
        Assert.True(second.IsFailure);
        Assert.Equal(AutomationErrors.LimitReachedCode, second.Error.Code);
        Assert.Equal(50, await CountAsync("SELECT count(*) FROM automation_rule"));
    }

    [Fact]
    public async Task The_due_date_finder_pages_in_due_day_order()
    {
        var today = DateTime.UtcNow.Date;
        var late = await CreateItemAsync(Alpha, "Late", new JsonObject { ["due_date"] = today.AddDays(3).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var early = await CreateItemAsync(Alpha, "Early", new JsonObject { ["due_date"] = today.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var middle = await CreateItemAsync(Alpha, "Middle", new JsonObject { ["due_date"] = today.AddDays(2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var ruleId = await CreateRuleAsync(Alpha, "Due", """{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"09:00"}""", """[{"type":"notify","title":"x"}]""");

        await using var scope = fixture.Application.CreateUnscopedScope();
        var finder = scope.ServiceProvider.GetRequiredService<Nix.Abstractions.Automations.IAutomationCandidateFinder>();
        var from = DateOnly.FromDateTime(today);
        var to = from.AddDays(5);
        var page = await finder.FindDateCandidatesAsync(Alpha.TenantId, ruleId, from, to, 2, null, null, Cancellation);
        Assert.Equal([early, middle], page.Select(candidate => candidate.ItemId));
        Assert.Equal(today.AddDays(2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), page[^1].CursorDay);

        var next = await finder.FindDateCandidatesAsync(Alpha.TenantId, ruleId, from, to, 2, page[^1].CursorDay, page[^1].ItemId, Cancellation);
        Assert.Equal([late], next.Select(candidate => candidate.ItemId));
    }

    [Fact]
    public async Task Date_rules_plan_on_their_own_interval_and_a_preserved_rule_keeps_its_stale_rows()
    {
        var due = DateTime.UtcNow.AddHours(2);
        var itemId = await CreateItemAsync(Alpha, "Report", new JsonObject { ["due_date"] = due.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var ruleId = await CreateRuleAsync(Alpha, "Heads up", $$"""{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"{{due:HH:mm}}"}""",
            """[{"type":"notify","title":"x"}]""");
        await SavePreferencesAsync(Alpha);

        await using var scope = fixture.Application.CreateUnscopedScope();
        using var planner = new TriggerPlanner(scope.ServiceProvider.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System);
        await planner.PlanOnceAsync(Cancellation);
        var firstKey = await TextAsync($"SELECT dedupe_key FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'");
        Assert.NotNull(firstKey);

        // Within the date interval the same planner does not re-read date rules: the moved date's
        // stale trigger stays until the next date pass.
        await SetAsync(Alpha, itemId, $$"""{"due_date":"{{due.AddDays(1):yyyy-MM-dd}}"}""");
        await planner.PlanOnceAsync(Cancellation);
        Assert.Equal("pending", await TextAsync($"SELECT status FROM scheduled_trigger WHERE dedupe_key = '{firstKey}'"));

        // A reconcile that preserves the rule leaves its stale row; one that does not cancels it.
        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<IScheduledTriggerStore>();
            var start = DateTimeOffset.UtcNow;
            Assert.Equal(0, await store.CancelStaleAsync(Alpha.TenantId, Alpha.WorkspaceId, Alpha.PrincipalId,
                Nix.Domain.Scheduling.TriggerKind.Automation, AutomationPlanning.DateSource, start, start.AddHours(48), [], [ruleId], Cancellation));
            Assert.Equal(1, await store.CancelStaleAsync(Alpha.TenantId, Alpha.WorkspaceId, Alpha.PrincipalId,
                Nix.Domain.Scheduling.TriggerKind.Automation, AutomationPlanning.DateSource, start, start.AddHours(48), [], [], Cancellation));
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task A_colleagues_rule_watching_for_a_value_under_a_locked_parent_records_no_run()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var folder = await CreateItemAsync(Alpha, "Private folder", null);
        var diary = await CreateItemAsync(Alpha, "Secret diary", null, folder);
        var theirs = await CreateRuleAsync(colleague, "Tell me", """{"type":"property_changed","key":"status","to":{"value":"done"}}""",
            """[{"type":"notify","title":"Something is done"}]""");

        // The owner finishes the diary and locks the folder above it: the colleague's rule must not
        // learn that anything under the lock reached "done" - not even from a bare run-log row.
        await SetAsync(Alpha, diary, """{"status":"done"}""");
        await LockAsync(folder);
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{theirs}'"));
        await DispatchAllAsync();

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{theirs}'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'automation'"));
        Assert.Equal("skipped", await TextAsync($"SELECT status FROM scheduled_trigger WHERE rule_id = '{theirs}'"));
    }

    [Fact]
    public async Task A_date_rule_plans_nothing_for_a_locked_item()
    {
        var due = DateTime.UtcNow.AddHours(3);
        var folder = await CreateItemAsync(Alpha, "Private folder", null);
        var covered = await CreateItemAsync(Alpha, "Covered", new JsonObject { ["due_date"] = due.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) }, folder);
        var open = await CreateItemAsync(Alpha, "Open", new JsonObject { ["due_date"] = due.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        await ExecuteAsMigratorAsync($"UPDATE item SET properties = properties || jsonb_build_object('when', '{due:yyyy-MM-dd}') WHERE id IN ('{covered}', '{open}')");
        await LockAsync(folder);

        var byDue = await CreateRuleAsync(Alpha, "By due", $$"""{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"{{due:HH:mm}}"}""",
            """[{"type":"notify","title":"x"}]""");
        var byKey = await CreateRuleAsync(Alpha, "By key", $$"""{"type":"date_arrives","key":"when","offsetMinutes":0,"time":"{{due:HH:mm}}"}""",
            """[{"type":"notify","title":"x"}]""");
        await PlanAsync();

        // Both finder branches leave the covered item out; the open one is still planned.
        foreach (var ruleId in new[] { byDue, byKey })
        {
            Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND source_item_id = '{covered}'"));
            Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND source_item_id = '{open}' AND status = 'pending'"));
        }
    }

    [Fact]
    public async Task A_locked_item_and_a_missing_item_read_the_same_to_test_and_run_now()
    {
        var folder = await CreateItemAsync(Alpha, "Private folder", null);
        var diary = await CreateItemAsync(Alpha, "Secret diary", null, folder);
        var ruleId = await CreateRuleAsync(Alpha, "Probe", """{"type":"property_changed","key":"status"}""",
            """[{"type":"notify","title":"{item.title}"}]""");
        await LockAsync(folder);

        var answers = new List<string>();
        foreach (var candidate in new[] { diary, Guid.NewGuid() })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var dispatcher = work.Resolve<NixDispatcher>();
                var test = await dispatcher.SendAsync<TestAutomation, AutomationTestResponse>(new(ruleId, candidate), Cancellation);
                Assert.True(test.IsSuccess);
                var run = await dispatcher.SendAsync<RunAutomation, AutomationRunResponse>(new(ruleId, candidate), Cancellation);
                Assert.True(run.IsFailure);
                answers.Add($"{test.Value.WouldRun}|{test.Value.Reason}|{test.Value.Actions.Count}|{run.Error.Code}|{run.Error.Message}");
                await work.CommitAsync(Cancellation);
            }
        }

        Assert.Equal(answers[0], answers[1]);
        Assert.StartsWith("False|item_gone|0|", answers[0], StringComparison.Ordinal);
        Assert.Empty(await RunsAsync(ruleId));
    }

    [Fact]
    public async Task A_bulk_write_past_the_budget_notes_every_property_rule_of_the_workspace()
    {
        var byStatus = await CreateRuleAsync(Alpha, "Status", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        var byOther = await CreateRuleAsync(Alpha, "Other", """{"type":"property_changed","key":"other"}""", """[{"type":"notify","title":"x"}]""");
        await InsertBulkItemsAsync(1005);

        // One transaction: the budget is spent on "status", the first row past it changes
        // "status" again, and only later rows change "other" - which must still be noted.
        await ExecuteAsMigratorAsync("""
            BEGIN;
            UPDATE item SET properties = properties || '{"status":"done"}' WHERE properties ? 'bulk' AND seq <= 101000;
            UPDATE item SET properties = properties || '{"status":"again"}' WHERE properties ? 'bulk' AND seq = 101001;
            UPDATE item SET properties = properties || '{"other":"x"}' WHERE properties ? 'bulk' AND seq > 101001;
            COMMIT;
            """);

        foreach (var ruleId in new[] { byStatus, byOther })
        {
            Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND status = 'throttled' AND detail ->> 'reason' = 'bulk_write'"));
        }
    }

    [Fact]
    public async Task Runs_the_property_trigger_writes_are_trimmed_to_500_as_well()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Status", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO automation_run (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin, depth, status, created_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{ruleId}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaWorkspace}',
                   NULL, 'old:' || n, 'property', 0, 'throttled', now() - interval '2 hours' - n * interval '1 second'
              FROM generate_series(1, 510) n;
            """);
        await InsertBulkItemsAsync(1001);

        // Only the database trigger records this rule's run - the executor never sees it.
        await ExecuteAsMigratorAsync("UPDATE item SET properties = properties || '{\"status\":\"done\"}' WHERE properties ? 'bulk'");

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}' AND detail ->> 'reason' = 'bulk_write'"));
        Assert.Equal(500, await CountAsync($"SELECT count(*) FROM automation_run WHERE rule_id = '{ruleId}'"));
    }

    [Fact]
    public async Task A_member_removed_from_the_workspace_cannot_update_a_rule_or_probe_items_through_it()
    {
        await SeedColleagueAsync("editor");
        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var existing = await CreateItemAsync(Alpha, "Roadmap", null);
        const string trigger = """{"type":"property_changed","key":"status"}""";
        var ruleId = await CreateRuleAsync(colleague, "Theirs", trigger, """[{"type":"notify","title":"x"}]""");
        await ExecuteAsMigratorAsync($"DELETE FROM workspace_member WHERE subject_id = '{Colleague}'");

        // Disabling needs no write access, but it still needs to read the workspace; and naming a
        // real item and a made-up one must read the same.
        var codes = new List<string>();
        foreach (var named in new[] { existing, Guid.NewGuid() })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(colleague, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var saved = await work.Resolve<NixDispatcher>().SendAsync<UpdateAutomation, AutomationRuleResponse>(
                    new(ruleId, 1, Input("Theirs", trigger, $$"""[{"type":"set_property","target":{"itemId":"{{named}}"},"key":"k","value":1}]""", enabled: false)),
                    Cancellation);
                Assert.True(saved.IsFailure);
                codes.Add(saved.Error.Code);
            }
        }

        Assert.Equal([AutomationErrors.NotFoundCode, AutomationErrors.NotFoundCode], codes);
        Assert.Equal("true|1", await TextAsync($"SELECT enabled::text || '|' || revision FROM automation_rule WHERE id = '{ruleId}'"));
    }

    [Fact]
    public async Task Saving_or_reenabling_a_date_rule_plans_its_triggers_at_once()
    {
        var due = DateTime.UtcNow.AddHours(3);
        var itemId = await CreateItemAsync(Alpha, "Report", new JsonObject { ["due_date"] = due.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        await SavePreferencesAsync(Alpha);
        var trigger = $$"""{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"{{due:HH:mm}}"}""";
        const string actions = """[{"type":"notify","title":"x"}]""";

        // No planner pass anywhere in this test.
        var ruleId = await CreateRuleAsync(Alpha, "Heads up", trigger, actions);
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND source_item_id = '{itemId}' AND status = 'pending'"));

        await UpdateRuleAsync(Alpha, ruleId, 1, "Heads up", trigger, actions, enabled: false);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'"));

        await UpdateRuleAsync(Alpha, ruleId, 2, "Heads up", trigger, actions, enabled: true);
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND source_item_id = '{itemId}' AND status = 'pending'"));

        // An edit that moves the time replans to the new instant.
        var earlier = due.AddMinutes(-30);
        await UpdateRuleAsync(Alpha, ruleId, 3, "Heads up", $$"""{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"{{earlier:HH:mm}}"}""", actions, enabled: true);
        Assert.Equal($"{earlier:HH:mm}", await TextAsync($"SELECT to_char(fire_at AT TIME ZONE 'UTC', 'HH24:MI') FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND status = 'pending'"));
    }

    [Fact]
    public async Task A_date_group_reads_a_window_sized_by_its_offsets_and_logs_a_truncated_group()
    {
        var today = DateTime.UtcNow.Date;
        var soon = DateTime.UtcNow.AddHours(26);

        // More than a group's cap (2,000) of items due five days ago: with offset zero none can fire, and
        // none may crowd out the one item that can.
        await InsertBulkItemsAsync(2_001, today.AddDays(-5));
        var itemId = await CreateItemAsync(Alpha, "Tomorrow", new JsonObject { ["due_date"] = soon.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });
        var ruleId = await CreateRuleAsync(Alpha, "Due", """{"type":"date_arrives","key":"due_date","offsetMinutes":0,"time":"00:30"}""",
            """[{"type":"notify","title":"x"}]""");
        await PlanAsync();
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{ruleId}' AND source_item_id = '{itemId}' AND status = 'pending'"));

        // A group that really is past its cap is named in a warning, by ids and counts only.
        await ExecuteAsMigratorAsync($"UPDATE item SET properties = properties || jsonb_build_object('due_date', '{soon:yyyy-MM-dd}') WHERE properties ? 'bulk'");
        await using var scope = fixture.Application.CreateUnscopedScope();
        var provider = scope.ServiceProvider;
        var logger = new CapturingLogger<AutomationDateSource>();
        var source = new AutomationDateSource(
            provider.GetRequiredService<PlannedAutomationRules>(),
            provider.GetRequiredService<Nix.Abstractions.Automations.IAutomationCandidateFinder>(),
            provider.GetRequiredService<IReminderCandidateFinder>(),
            provider.GetRequiredService<AutomationExecutor>(),
            logger);
        var now = DateTimeOffset.UtcNow;
        var plan = await source.PlanAsync(new PlanWindow(now, now.AddHours(48)), Cancellation);

        Assert.Contains(ruleId, plan.IncompleteRules ?? []);
        var warning = Assert.Single(logger.Events, entry => entry.EventId.Id == 5320);
        Assert.Equal(LogLevel.Warning, warning.Level);
        Assert.Contains(TestTenants.AlphaWorkspace.ToString(), warning.Message, StringComparison.Ordinal);
        Assert.Contains("due_date", warning.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Bulk", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_unfiltered_lease_reads_pending_rows_in_index_order_without_a_sort()
    {
        var ruleId = await CreateRuleAsync(Alpha, "Backlog", """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""");
        await ExecuteAsMigratorAsync($"""
            INSERT INTO scheduled_trigger (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                                           fire_at, dedupe_key, status, attempts, created_at, updated_at)
            SELECT '{TestTenants.Alpha}', gen_random_uuid(), '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaPrincipal}', 'automation',
                   'automation.property', NULL, '{ruleId}', date_trunc('minute', now()) - interval '1 minute',
                   'tied-' || n, 'pending', 0, now(), now()
              FROM generate_series(1, 20000) n;
            ANALYZE scheduled_trigger;
            """);

        // The pending branch of nix_lease_due_triggers, as it reads with no source filter: every
        // row shares one fire_at, so only an index ending in id returns them in order.
        IReadOnlyList<string> plan;
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            plan = await RawSql.TextListAsync(connection, """
                EXPLAIN SELECT p.id, p.fire_at FROM public.scheduled_trigger p
                 WHERE p.status = 'pending' AND p.fire_at <= clock_timestamp()
                 ORDER BY p.fire_at, p.id LIMIT 50 FOR UPDATE SKIP LOCKED
                """);
        }

        var text = string.Join('\n', plan);
        Assert.Contains("ix_scheduled_trigger_pending_due", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Sort", text, StringComparison.Ordinal);
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
        for (var pass = 0; pass < 10; pass++)
        {
            // A chained rule's trigger is enqueued during the pass before, a minute ahead.
            if (pass > 0)
            {
                await PullDueForwardAsync();
            }

            if (await dispatcher.DispatchOnceAsync(Cancellation) == 0)
            {
                break;
            }
        }
    }

    // A property change fires at the start of the next minute (the trailing edge of its burst),
    // so a test dispatching straight after a write pulls those forward too.
    private Task PullDueForwardAsync() => ExecuteAsMigratorAsync("""
        UPDATE scheduled_trigger SET fire_at = now() - interval '1 second'
         WHERE status = 'pending'
           AND (fire_at <= now() + interval '5 seconds'
                OR (source = 'automation.property' AND fire_at <= now() + interval '61 seconds'))
        """);

    private async Task<Result<AutomationRuleResponse>> CreateInOwnUnitOfWorkAsync(string name)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(Alpha.WorkspaceId!.Value, Input(name, """{"type":"property_changed","key":"status"}""", """[{"type":"notify","title":"x"}]""")), Cancellation);
            if (created.IsSuccess)
            {
                await work.CommitAsync(Cancellation);
            }

            return created;
        }
    }

    /// <summary>Root items marked <c>bulk</c>, with seq 100001 upwards, optionally all due on one day.</summary>
    private Task InsertBulkItemsAsync(int count, DateTime? dueDay = null)
    {
        var due = dueDay is { } day ? $", 'due_date', '{day:yyyy-MM-dd}'" : string.Empty;
        return ExecuteAsMigratorAsync($"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'task', NULL, 100000 + n,
                   jsonb_build_object('title', 'Bulk ' || n, 'bulk', true{due}), 'active',
                   '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now()
              FROM generate_series(1, {count}) n;
            """);
    }

    private async Task LockAsync(Guid itemId)
    {
        // Locked from a browser session that therefore holds a grant past the lock; the rule's
        // owner is that same person, and the rule must still leave the item alone.
        var work = await fixture.Application.BeginUnitOfWorkAsync(Alpha, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.Resolve<CredentialSessionContext>().Set(Guid.NewGuid());
            var locked = await work.Resolve<NixDispatcher>().SendAsync<Nix.Features.Locks.LockItem, bool>(
                new Nix.Features.Locks.LockItem(ItemId.From(itemId), "hunter22", null), Cancellation);
            Assert.True(locked.IsSuccess, locked.IsFailure ? locked.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
        }
    }

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
