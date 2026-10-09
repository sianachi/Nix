using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Query;

namespace Nix.Tests.Features.Query;

/// <summary>
/// What the ad-hoc workspace query does before it asks for rows: refuses what its grammar refuses
/// before reading anything, answers a hidden workspace or container exactly as their own reads do,
/// runs over the one workspace named and no other, and resolves its rules through the same
/// evaluator the saved view uses. Rows are proven on real Postgres in
/// <c>WorkspaceQueryIntegrationTests</c>.
/// </summary>
public sealed class WorkspaceQueryTests
{
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId OtherReadable = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly WorkspaceId Hidden = WorkspaceId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly TenantId Tenant = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999"));
    private static readonly PrincipalId Caller = PrincipalId.From(new Guid("77777777-7777-4777-8777-777777777777"));
    private static readonly ItemId Folder = ItemId.From(new Guid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"));
    private static readonly ItemId HiddenFolder = ItemId.From(new Guid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"));
    private static readonly ItemId OtherWorkspaceFolder = ItemId.From(new Guid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceQueryInput Input(
        ImmutableArray<FilterRule> filters = default,
        WorkspaceId? workspace = null,
        ItemId? parent = null,
        bool descendants = true,
        string? preset = null,
        string? sort = null,
        bool descending = false,
        string? groupBy = null,
        ImmutableArray<string> groupOrder = default,
        string? today = "2026-08-15") =>
        new(workspace ?? Workspace, parent, descendants, preset, filters, sort, descending, groupBy, groupOrder, today);

    private static WorkspaceQueryHandler Handler(
        IItemQuery query,
        bool open = true,
        NixSessionContext? session = null,
        StubPreferences? preferences = null,
        QueryConcurrencyLimiter? limiter = null) =>
        new(
            StubTree.With(
                [ItemIn(Folder, Workspace), ItemIn(HiddenFolder, Hidden), ItemIn(OtherWorkspaceFolder, OtherReadable)],
                Workspace,
                OtherReadable,
                Hidden),
            new StubPermissions([Workspace, OtherReadable]),
            query,
            new StubSession(session ?? NixSessionContext.ForTenant(Tenant, Caller)),
            new StubLocks(open),
            preferences ?? new StubPreferences(),
            limiter ?? new QueryConcurrencyLimiter());

    private static async Task<Result<WorkspaceQueryResults>> Run(IItemQuery query, WorkspaceQueryInput input, int? limit = null, bool open = true) =>
        await Handler(query, open).HandleAsync(new RunWorkspaceQuery(input, limit), Cancellation);

    [Fact]
    public async Task The_query_runs_over_the_named_workspace_only_even_when_the_caller_reads_more()
    {
        var query = new RecordingQuery();

        var result = await Run(query, Input());

        Assert.True(result.IsSuccess);
        Assert.Equal<IReadOnlyList<WorkspaceId>>([Workspace], query.LastReadableWorkspaces);
        Assert.Null(query.LastSpec!.ExcludedItemId);
        Assert.Null(query.LastSpec.Scope);
    }

    [Fact]
    public async Task A_workspace_the_caller_cannot_read_is_not_found_and_never_queried()
    {
        var query = new RecordingQuery();

        var hidden = await Run(query, Input(workspace: Hidden));
        var missing = await Run(query, Input(workspace: WorkspaceId.From(Guid.NewGuid())));

        Assert.Equal("workspaces.not_found", hidden.Error.Code);
        Assert.Equal("workspaces.not_found", missing.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task A_scope_container_the_caller_cannot_read_answers_the_item_reads_404_and_is_never_queried()
    {
        // Three ways a container is not visible here - missing, in an unreadable workspace, in a
        // different workspace than the one named - and one code for all of them: the item read's.
        var query = new RecordingQuery();

        var missing = await Run(query, Input(parent: ItemId.From(Guid.NewGuid())));
        var hidden = await Run(query, Input(parent: HiddenFolder));
        var elsewhere = await Run(query, Input(parent: OtherWorkspaceFolder));

        Assert.All([missing, hidden, elsewhere], result => Assert.Equal("items.not_found", result.Error.Code));
        Assert.Equal(Nix.Features.Items.ItemErrors.NotFound("x").Code, hidden.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task A_locked_scope_container_is_refused_rather_than_answered_empty()
    {
        var query = new RecordingQuery();

        var result = await Run(query, Input(parent: Folder), open: false);

        Assert.Equal("items.locked", result.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_readable_scope_is_handed_to_the_statement(bool descendants)
    {
        var query = new RecordingQuery();

        await Run(query, Input(parent: Folder, descendants: descendants));

        Assert.Equal(new QueryScope(Folder, descendants), query.LastSpec!.Scope);
    }

    [Theory]
    [InlineData(null, 100)]
    [InlineData(25, 25)]
    [InlineData(10_000, 500)]
    [InlineData(0, 1)]
    public async Task The_limit_defaults_to_one_hundred_and_is_capped_at_five_hundred(int? asked, int applied)
    {
        var query = new RecordingQuery();

        var result = await Run(query, Input(), asked);

        Assert.Equal(applied, query.LastLimit);
        Assert.Equal(applied, result.Value.Limit);
    }

    [Fact]
    public async Task Rules_the_grammar_refuses_are_refused_before_anything_is_read()
    {
        var query = new RecordingQuery();

        var badOperator = await Run(query, Input([new FilterRule("due", "sometime", "x")]));
        var badField = await Run(query, Input([new FilterRule("$tag", "equals", "x")]));
        var nested = await Run(query, Input([FilterRule.Group([FilterRule.Group([new FilterRule("a", "is-empty", "")])])]));
        var badPreset = await Run(query, Input(preset: "someday"));

        Assert.All([badOperator, badField, nested, badPreset], result => Assert.Equal("query.invalid_request", result.Error.Code));
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task A_hidden_workspace_with_bad_rules_is_refused_for_the_rules_alone()
    {
        // The grammar is checked first and is a function of the request, so the same bad request
        // answers the same way whichever workspace it names: nothing about the workspace leaks.
        var query = new RecordingQuery();

        var hidden = await Run(query, Input([new FilterRule("due", "sometime", "x")], workspace: Hidden));
        var readable = await Run(query, Input([new FilterRule("due", "sometime", "x")]));

        Assert.Equal(readable.Error, hidden.Error);
    }

    [Fact]
    public async Task The_preset_and_the_filters_share_the_eight_rule_ceiling()
    {
        var query = new RecordingQuery();
        var seven = Enumerable.Range(0, 7).Select(index => new FilterRule($"k{index}", "is-not-empty", string.Empty)).ToImmutableArray();

        var fits = await Run(query, Input(seven, preset: "today"));
        var over = await Run(query, Input(seven, preset: "overdue"));

        Assert.True(fits.IsSuccess);
        Assert.Equal(8, query.LastRules.Length);
        Assert.Equal("query.invalid_request", over.Error.Code);
    }

    [Fact]
    public async Task Each_preset_is_the_smart_list_it_names()
    {
        var query = new RecordingQuery();

        await Run(query, Input(preset: "overdue"));

        Assert.Equal(
            [new FilterRule("due_date", "before", "today"), new FilterRule("completion", "not-equals", "true")],
            query.LastRules);
    }

    [Fact]
    public async Task Rules_that_read_today_need_today_and_others_do_not()
    {
        var query = new RecordingQuery();

        var windowWithout = await Run(query, Input([new FilterRule("due", "within-last", "7")], today: null));
        var tokenWithout = await Run(query, Input([new FilterRule("due", "on", "start-of-month")], today: null));
        var literalWithout = await Run(query, Input([new FilterRule("due", "on", "2026-08-01")], today: null));
        var malformed = await Run(query, Input(today: "15/08/2026"));

        Assert.Equal("query.invalid_today", windowWithout.Error.Code);
        Assert.Equal("query.invalid_today", tokenWithout.Error.Code);
        Assert.Equal("query.invalid_today", malformed.Error.Code);
        Assert.True(literalWithout.IsSuccess);
        Assert.Null(literalWithout.Value.Today);
    }

    [Fact]
    public async Task Me_resolves_to_the_session_principal_on_equalities_only_inside_groups_too()
    {
        var query = new RecordingQuery();

        await Run(query, Input(
        [
            new FilterRule("assignee", "equals", "me"),
            FilterRule.Group([new FilterRule("reviewer", "not-equals", "me"), new FilterRule("title", "contains", "me")]),
        ]));

        Assert.Equal(Caller.ToString(), query.LastRules[0].Value);
        Assert.Equal(Caller.ToString(), query.LastRules[1].Any[0].Value);
        Assert.Equal("me", query.LastRules[1].Any[1].Value);
    }

    [Fact]
    public async Task An_explicit_sort_wins_over_a_date_rule_and_a_date_rule_wins_over_recency()
    {
        var sorted = new RecordingQuery();
        var dated = new RecordingQuery();

        await Run(sorted, Input([new FilterRule("due", "before", "today")], sort: "$created", descending: true));
        await Run(dated, Input([new FilterRule("due", "before", "today")]));

        Assert.Equal(new QueryOrder("$created", IsDay: false, Descending: true), sorted.LastOrder);
        Assert.Equal(new QueryOrder("due", IsDay: true, Descending: false), dated.LastOrder);
    }

    [Theory]
    [InlineData("$tag")]
    [InlineData("$done")]
    [InlineData("$habit_status")]
    public async Task Only_the_listed_structural_fields_sort_or_group(string key)
    {
        var query = new RecordingQuery();

        var sort = await Run(query, Input(sort: key));
        var group = await Run(query, Input(groupBy: key));

        Assert.Equal("query.invalid_request", sort.Error.Code);
        Assert.Equal("query.invalid_request", group.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task A_grouping_carries_its_order_and_refuses_an_overlong_one()
    {
        var query = new RecordingQuery();

        var grouped = await Run(query, Input(groupBy: "status", groupOrder: ["Todo", "Doing"]));
        var overlong = await Run(query, Input(groupBy: "status", groupOrder: [.. Enumerable.Range(0, 101).Select(index => $"k{index}")]));

        Assert.Equal("status", grouped.Value.GroupBy);
        Assert.Equal(["Todo", "Doing"], query.LastSpec!.Grouping!.Order);
        Assert.Equal("query.invalid_request", overlong.Error.Code);
    }

    [Theory]
    [InlineData("count", "points", false)]
    [InlineData("count", null, true)]
    [InlineData("sum", null, false)]
    [InlineData("sum", "points", true)]
    [InlineData("avg", "$type", false)]
    [InlineData("median", "points", false)]
    public async Task An_aggregate_needs_a_known_fold_and_a_property_exactly_when_it_folds_one(string function, string? property, bool accepted)
    {
        var query = new RecordingQuery();

        var result = await Handler(query).HandleAsync(new AggregateWorkspaceQuery(Input(), function, property), Cancellation);

        Assert.Equal(accepted, result.IsSuccess);
        Assert.Equal(accepted ? 1 : 0, query.Calls);
        if (accepted)
        {
            Assert.Equal(WorkspaceQueryHandler.MaximumGroups, query.LastLimit);
            Assert.Equal(new QueryAggregate(function, property), query.LastAggregate);
            Assert.Equal<IReadOnlyList<WorkspaceId>>([Workspace], query.LastReadableWorkspaces);
        }
        else
        {
            Assert.Equal("query.invalid_request", result.Error.Code);
        }
    }

    [Fact]
    public async Task An_aggregate_over_a_hidden_container_answers_the_same_404()
    {
        var query = new RecordingQuery();

        var result = await Handler(query).HandleAsync(
            new AggregateWorkspaceQuery(Input(parent: HiddenFolder), "count", null),
            Cancellation);

        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public void The_presets_match_the_smart_lists_the_web_applies()
    {
        // SMART_LISTS in @nix/structure-spec, spelled out: the same four names and the same rules.
        Assert.Equal(["assigned-to-me", "next-seven-days", "overdue", "today"], QueryPresets.All.Keys.Order(StringComparer.Ordinal));
        Assert.Equal([new FilterRule("due_date", "on", "today")], QueryPresets.All["today"]);
        Assert.Equal([new FilterRule("due_date", "within-next", "7")], QueryPresets.All["next-seven-days"]);
        Assert.Equal([new FilterRule("assignee", "equals", "me")], QueryPresets.All["assigned-to-me"]);
    }

    [Theory]
    [InlineData("1899-12-31")]
    [InlineData("9001-01-01")]
    [InlineData("9999-12-31")]
    [InlineData("0001-01-01")]
    public async Task A_today_outside_1900_to_9000_is_refused_before_any_token_or_window_resolves(string today)
    {
        // Unbounded, 9999-12-31 plus a seven-day window and 0001-01-01 minus a week both threw.
        var query = new RecordingQuery();

        var window = await Run(query, Input([new FilterRule("due", "within-next", "7")], today: today));
        var token = await Run(query, Input([new FilterRule("$created", "on", "same-day-last-week")], today: today));

        Assert.Equal("query.invalid_today", window.Error.Code);
        Assert.Equal("query.invalid_today", token.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Theory]
    [InlineData(true, "query.timed_out")]
    [InlineData(false, "query.could_not_run")]
    public async Task A_statement_the_database_refuses_answers_a_stable_code(bool timedOut, string code)
    {
        var rows = await Handler(new FailingQuery(timedOut)).HandleAsync(new RunWorkspaceQuery(Input(), null), Cancellation);
        var folded = await Handler(new FailingQuery(timedOut)).HandleAsync(new AggregateWorkspaceQuery(Input(), "count", null), Cancellation);

        Assert.Equal(code, rows.Error.Code);
        Assert.Equal(code, folded.Error.Code);
    }

    [Fact]
    public async Task The_callers_zone_is_read_only_when_a_rule_needs_it_and_unknown_zones_fall_back_to_utc()
    {
        var plain = new StubPreferences("Pacific/Auckland");
        var query = new RecordingQuery();
        await Handler(query, preferences: plain).HandleAsync(new RunWorkspaceQuery(Input([new FilterRule("status", "equals", "Doing")]), null), Cancellation);
        Assert.Equal(0, plain.Reads);
        Assert.Equal(NodaTime.DateTimeZone.Utc, query.LastSpec!.Zone);

        await Handler(query, preferences: plain).HandleAsync(new RunWorkspaceQuery(Input([new FilterRule("$created", "on", "today")]), null), Cancellation);
        Assert.Equal(1, plain.Reads);
        Assert.Equal("Pacific/Auckland", query.LastSpec!.Zone.Id);

        await Handler(query, preferences: new StubPreferences("Mars/Olympus")).HandleAsync(new RunWorkspaceQuery(Input([new FilterRule("$created", "on", "today")]), null), Cancellation);
        Assert.Equal(NodaTime.DateTimeZone.Utc, query.LastSpec!.Zone);
    }

    [Fact]
    public async Task One_principal_may_have_at_most_four_queries_in_flight()
    {
        var limiter = new QueryConcurrencyLimiter();
        var held = Enumerable.Range(0, QueryConcurrencyLimiter.MaximumInFlight).Select(_ => limiter.TryEnter(Caller)).ToList();
        Assert.All(held, Assert.NotNull);

        var query = new RecordingQuery();
        var refused = await Handler(query, limiter: limiter).HandleAsync(new RunWorkspaceQuery(Input(), null), Cancellation);
        Assert.Equal("query.too_many_in_flight", refused.Error.Code);
        Assert.Equal(0, query.Calls);

        // Another principal is not held back by this one, and a released slot is free again.
        Assert.NotNull(limiter.TryEnter(PrincipalId.From(Guid.NewGuid())));
        held[0]!.Dispose();
        var admitted = await Handler(query, limiter: limiter).HandleAsync(new RunWorkspaceQuery(Input(), null), Cancellation);
        Assert.True(admitted.IsSuccess);
    }

    private static Item ItemIn(ItemId id, WorkspaceId workspace) => new()
    {
        Id = id,
        TenantId = Tenant,
        WorkspaceId = workspace,
        Type = "note",
        Seq = 1,
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = Caller,
        LastModifiedBy = Caller,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };
}
