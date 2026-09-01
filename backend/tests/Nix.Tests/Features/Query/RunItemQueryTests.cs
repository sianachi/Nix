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
/// What the run-query use case does before, during and after it asks for rows. The assertions
/// that matter are the ones about its relationship with the stored view and the permission
/// resolver: the client never supplies rules, a set that no longer validates refuses to run, and
/// the readable set the resolver produced is the exact set handed into the query. Rows are proven
/// against real Postgres with two tenants in <c>Nix.Integration.Tests</c>.
/// </summary>
public sealed class RunItemQueryTests
{
    private static readonly ItemId SmartList = ItemId.From(new Guid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    private static readonly WorkspaceId Readable = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId AlsoReadable = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly TenantId Tenant = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999"));
    private static readonly PrincipalId Caller = PrincipalId.From(new Guid("77777777-7777-4777-8777-777777777777"));
    private static readonly PrincipalId OtherCaller = PrincipalId.From(new Guid("88888888-8888-4888-8888-888888888888"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_malformed_today_is_refused_before_anything_is_read()
    {
        var query = new RecordingQuery();
        var handler = Handler(query, ItemWithViews(OverdueViews()));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "overdue", "someday"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("query.invalid_today", result.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task An_item_the_caller_may_not_read_is_not_found_and_never_queried()
    {
        var query = new RecordingQuery();
        var handler = new RunItemQueryHandler(
            new StubTree(null),
            new StubPermissions([Readable]),
            query,
            new StubSession(SessionFor(Caller)));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "overdue", "2026-08-15"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task A_view_the_item_does_not_have_is_not_found()
    {
        var handler = Handler(new RecordingQuery(), ItemWithViews(OverdueViews()));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "missing", "2026-08-15"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("query.view_not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_view_of_another_kind_has_nothing_to_run()
    {
        var views = ViewDefinitionsJson.Write(
            [new ViewDefinition("board", "Board", ViewKind.Board, [], "status", [], null, null, false)]);
        var handler = Handler(new RecordingQuery(), ItemWithViews(views));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "board", "2026-08-15"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("query.view_not_found", result.Error.Code);
    }

    [Fact]
    public async Task Stored_rules_that_no_longer_validate_refuse_to_run()
    {
        // The fail-closed line: the stored-JSON reader drops malformed rules fail-soft, and a
        // dropped rule can only widen a query - so what survives is re-validated here, and a set
        // that no longer passes never reaches the rows.
        var views = """
            {"views":[{"id":"q","name":"Q","kind":"query","filters":[
                {"property":"due","operator":"sometime-around","value":"x"}]}]}
            """;
        var query = new RecordingQuery();
        var handler = Handler(query, ItemWithViews(views));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "q", "2026-08-15"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("query.invalid_rules", result.Error.Code);
        Assert.Equal(0, query.Calls);
    }

    [Fact]
    public async Task The_readable_workspaces_the_resolver_returned_are_handed_into_the_query()
    {
        // The whole security property at the seam a unit test can see: the set the single
        // authorization code path produced is the set the query filters with.
        var query = new RecordingQuery();
        var handler = new RunItemQueryHandler(
            new StubTree(ItemWithViews(OverdueViews())),
            new StubPermissions([Readable, AlsoReadable]),
            query,
            new StubSession(SessionFor(Caller)));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "overdue", "2026-08-15"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal<IReadOnlyList<WorkspaceId>>([Readable, AlsoReadable], query.LastReadableWorkspaces);
        Assert.Equal(SmartList, query.LastQueryItemId);
        Assert.Equal(RunItemQueryHandler.MaximumResults, query.LastLimit);
    }

    [Fact]
    public async Task The_first_date_shaped_rule_orders_the_rows_soonest_first()
    {
        var query = new RecordingQuery();
        var handler = Handler(query, ItemWithViews(OverdueViews()));

        await handler.HandleAsync(new RunItemQuery(SmartList, "overdue", "2026-08-15"), Cancellation);

        Assert.Equal(new QueryOrder("due", IsDay: true, Descending: false), query.LastOrder);
    }

    [Fact]
    public async Task A_query_with_no_date_rule_falls_back_to_the_view_sort_then_recency()
    {
        var sorted = ViewDefinitionsJson.Write(
            [new ViewDefinition(
                "q", "Q", ViewKind.Query, [], null, [], null, "status", true,
                Filters: [new FilterRule("status", "equals", "Doing")])]);
        var bare = ViewDefinitionsJson.Write(
            [new ViewDefinition("q", "Q", ViewKind.Query, [], null, [], null, null, false)]);

        var withSort = new RecordingQuery();
        await Handler(withSort, ItemWithViews(sorted))
            .HandleAsync(new RunItemQuery(SmartList, "q", "2026-08-15"), Cancellation);
        Assert.Equal(new QueryOrder("status", IsDay: false, Descending: true), withSort.LastOrder);

        var unconfigured = new RecordingQuery();
        await Handler(unconfigured, ItemWithViews(bare))
            .HandleAsync(new RunItemQuery(SmartList, "q", "2026-08-15"), Cancellation);
        Assert.Equal(QueryOrder.Recency, unconfigured.LastOrder);
    }

    [Fact]
    public async Task An_empty_filter_set_runs_and_means_everything_readable()
    {
        var query = new RecordingQuery();
        var bare = ViewDefinitionsJson.Write(
            [new ViewDefinition("q", "Q", ViewKind.Query, [], null, [], null, null, false)]);
        var handler = Handler(query, ItemWithViews(bare));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "q", "2026-08-15"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, query.Calls);
        Assert.True(query.LastRules.IsEmpty);
    }

    [Fact]
    public void The_item_code_this_feature_reuses_is_the_one_the_items_feature_publishes()
    {
        Assert.Equal("items.not_found", Nix.Features.Items.ItemErrors.NotFound("why").Code);
    }

    [Fact]
    public async Task Assigned_to_me_resolves_to_the_calling_principals_own_identifier()
    {
        var query = new RecordingQuery();
        var views = MineView("equals");
        var handler = new RunItemQueryHandler(
            new StubTree(ItemWithViews(views)),
            new StubPermissions([Readable]),
            query,
            new StubSession(SessionFor(Caller)));

        var result = await handler.HandleAsync(new RunItemQuery(SmartList, "mine", "2026-08-15"), Cancellation);

        Assert.True(result.IsSuccess);
        var rule = Assert.Single(query.LastRules);
        Assert.Equal("assignee", rule.Property);
        Assert.Equal("equals", rule.Operator);
        Assert.Equal(Caller.ToString(), rule.Value);
        Assert.NotEqual(QueryOperators.Me, rule.Value);
    }

    [Fact]
    public async Task Not_equals_me_resolves_too_and_keeps_its_operator()
    {
        var query = new RecordingQuery();
        var views = MineView("not-equals");
        var handler = new RunItemQueryHandler(
            new StubTree(ItemWithViews(views)),
            new StubPermissions([Readable]),
            query,
            new StubSession(SessionFor(Caller)));

        await handler.HandleAsync(new RunItemQuery(SmartList, "mine", "2026-08-15"), Cancellation);

        var rule = Assert.Single(query.LastRules);
        Assert.Equal("not-equals", rule.Operator);
        Assert.Equal(Caller.ToString(), rule.Value);
    }

    [Fact]
    public async Task Two_different_callers_compiling_the_same_stored_rule_get_different_values()
    {
        // The whole point of the token: the same saved "assigned to me" view means something
        // different depending on who runs it.
        var views = MineView("equals");

        var firstCallerQuery = new RecordingQuery();
        await new RunItemQueryHandler(
                new StubTree(ItemWithViews(views)),
                new StubPermissions([Readable]),
                firstCallerQuery,
                new StubSession(SessionFor(Caller)))
            .HandleAsync(new RunItemQuery(SmartList, "mine", "2026-08-15"), Cancellation);

        var secondCallerQuery = new RecordingQuery();
        await new RunItemQueryHandler(
                new StubTree(ItemWithViews(views)),
                new StubPermissions([Readable]),
                secondCallerQuery,
                new StubSession(SessionFor(OtherCaller)))
            .HandleAsync(new RunItemQuery(SmartList, "mine", "2026-08-15"), Cancellation);

        var firstValue = Assert.Single(firstCallerQuery.LastRules).Value;
        var secondValue = Assert.Single(secondCallerQuery.LastRules).Value;

        Assert.Equal(Caller.ToString(), firstValue);
        Assert.Equal(OtherCaller.ToString(), secondValue);
        Assert.NotEqual(firstValue, secondValue);
    }

    [Fact]
    public async Task A_missing_session_context_fails_loudly_rather_than_guessing_a_principal()
    {
        // There is no anonymous path to this query, so a missing context is a bug in the pipeline
        // that set up the unit of work - not an input to refuse gracefully. Matching nobody's
        // items, or everybody's, would both be the quiet kind of wrong.
        var query = new RecordingQuery();
        var handler = new RunItemQueryHandler(
            new StubTree(ItemWithViews(OverdueViews())),
            new StubPermissions([Readable]),
            query,
            new StubSession(null));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => handler.HandleAsync(new RunItemQuery(SmartList, "overdue", "2026-08-15"), Cancellation).AsTask());

        Assert.Equal(0, query.Calls);
    }

    private static string? MineView(string @operator) =>
        ViewDefinitionsJson.Write(
            [new ViewDefinition(
                "mine",
                "Mine",
                ViewKind.Query,
                [],
                null,
                [],
                null,
                null,
                false,
                Filters: [new FilterRule("assignee", @operator, QueryOperators.Me)])]);

    private static string? OverdueViews() =>
        ViewDefinitionsJson.Write(
            [new ViewDefinition(
                "overdue",
                "Overdue",
                ViewKind.Query,
                [],
                null,
                [],
                null,
                null,
                false,
                Filters:
                [
                    new FilterRule("due", "before", "today"),
                    new FilterRule("done", "not-equals", "true"),
                ])]);

    private static RunItemQueryHandler Handler(IItemQuery query, Item? item) =>
        new(new StubTree(item), new StubPermissions([Readable]), query, new StubSession(SessionFor(Caller)));

    private static NixSessionContext SessionFor(PrincipalId principal) => NixSessionContext.ForTenant(Tenant, principal);

    private static Item ItemWithViews(string? views) => new()
    {
        Id = SmartList,
        TenantId = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999")),
        WorkspaceId = Readable,
        Type = "query",
        Seq = 1,
        Views = views,
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = PrincipalId.From(new Guid("55555555-5555-4555-8555-555555555555")),
        LastModifiedBy = PrincipalId.From(new Guid("55555555-5555-4555-8555-555555555555")),
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    /// <summary>Finds the one prepared item, however it is asked.</summary>
    private sealed class StubTree : IItemTree
    {
        private readonly Item? _item;

        internal StubTree(Item? item) => _item = item;

        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_item?.Id == id ? _item : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            bool includeDeleted,
            long? afterSequence,
            int limit,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<long> NextSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<long> AllocateSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            ItemId movingId,
            ItemId? afterId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask InsertAsync(Item item, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateSchemaAsync(
            ItemId id,
            string? schema,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateViewsAsync(
            ItemId id,
            string? views,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TouchAsync(
            ItemId id,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WouldCreateCycleAsync(
            ItemId id,
            ItemId newParentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask ReparentAsync(
            ItemId id,
            ItemId? newParentId,
            long seq,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask SetLifecycleAsync(
            ItemId id,
            ItemLifecycleState state,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    /// <summary>Answers with a fixed session context, or none - the way a missing pipeline setup would.</summary>
    private sealed class StubSession : INixSessionContextAccessor
    {
        internal StubSession(NixSessionContext? current) => Current = current;

        public NixSessionContext? Current { get; }
    }

    /// <summary>Answers with a fixed readable set, the way the resolver does for one principal.</summary>
    private sealed class StubPermissions : IPermissionResolver
    {
        private readonly IReadOnlyList<WorkspaceId> _readable;

        internal StubPermissions(IReadOnlyList<WorkspaceId> readable) => _readable = readable;

        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    /// <summary>A query port that answers empty and remembers what it was asked.</summary>
    private sealed class RecordingQuery : IItemQuery
    {
        internal int Calls { get; private set; }

        internal ItemId LastQueryItemId { get; private set; }

        internal ImmutableArray<FilterRule> LastRules { get; private set; }

        internal QueryOrder? LastOrder { get; private set; }

        internal IReadOnlyList<WorkspaceId> LastReadableWorkspaces { get; private set; } = [];

        internal int LastLimit { get; private set; }

        public ValueTask<QueryResults> RunAsync(
            ItemId queryItemId,
            ImmutableArray<FilterRule> rules,
            QueryOrder order,
            DateOnly today,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            int limit,
            CancellationToken cancellationToken)
        {
            Calls++;
            LastQueryItemId = queryItemId;
            LastRules = rules;
            LastOrder = order;
            LastReadableWorkspaces = readableWorkspaces;
            LastLimit = limit;

            return ValueTask.FromResult(QueryResults.Empty);
        }
    }
}
