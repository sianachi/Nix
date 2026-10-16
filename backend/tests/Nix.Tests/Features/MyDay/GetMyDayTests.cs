using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Habits;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Features.MyDay;
using Nix.Features.Query;
using Nix.Messaging;
using Nix.Tests.Features.Query;
using Nix.Tests.Support;

namespace Nix.Tests.Features.MyDay;

/// <summary>
/// My Day's projection rules, free of any database: which candidates are tasks, which section a
/// task lands in, which occurrence is open, and what the read admits it could not establish. The
/// visibility predicates and limits placement are the real-Postgres suite's.
/// </summary>
public sealed class GetMyDayTests
{
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Hidden = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly TenantId Tenant = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999"));
    private static readonly PrincipalId Caller = PrincipalId.From(new Guid("77777777-7777-4777-8777-777777777777"));
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly Day = new(2026, 10, 16);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Tasks_land_in_today_overdue_or_assigned_once_and_in_that_order()
    {
        var result = await Read(Tasks(
            Task("assigned", due: "2026-10-20", assignee: Caller.ToString()),
            Task("overdue", due: "2026-10-01"),
            Task("today", due: "2026-10-16"),
            Task("nobody", due: "2026-10-20")));

        Assert.Equal(["today", "overdue", "assigned"], result.Tasks.Rows.Select(row => row.Title));
        Assert.Equal(["today", "overdue", "assigned"], result.Tasks.Rows.Select(row => row.Section));
        Assert.Equal("complete", result.Tasks.Coverage.Kind);
        Assert.All(result.Tasks.Rows, row => Assert.Equal("property", row.Action.Kind));
    }

    [Fact]
    public async Task A_lookalike_key_without_a_completion_field_is_not_a_task()
    {
        var schemaless = Task("looks like a task", due: "2026-10-16", schema: Plain());

        var result = await Read(Tasks(schemaless));

        Assert.Empty(result.Tasks.Rows);
        Assert.Equal("complete", result.Tasks.Coverage.Kind);
    }

    [Fact]
    public async Task Finished_and_not_yet_started_tasks_are_left_out_even_when_overdue()
    {
        var result = await Read(Tasks(
            Task("done", due: "2026-10-01", completion: "true"),
            Task("later", due: "2026-10-01", start: "2026-10-17"),
            Task("started", due: "2026-10-01", start: "2026-10-16")));

        Assert.Equal(["started"], result.Tasks.Rows.Select(row => row.Title));
    }

    [Fact]
    public async Task A_malformed_completion_value_is_reported_not_treated_as_open()
    {
        var result = await Read(Tasks(Task("odd", due: "2026-10-16", completion: "\"yes\"")));

        Assert.Empty(result.Tasks.Rows);
        Assert.Equal("partial", result.Tasks.Coverage.Kind);
        Assert.Equal(new MyDayCoverageReason("invalid_properties", 1), Assert.Single(result.Tasks.Coverage.Reasons));
    }

    [Fact]
    public async Task A_repeating_task_shows_only_todays_open_occurrence_through_the_series()
    {
        var open = Series("open", anchor: "2026-10-01", Rule(RecurrenceFrequency.Daily));
        var finished = Series("finished", anchor: "2026-10-01", Rule(RecurrenceFrequency.Daily) with { Completed = [Day] });
        var offDay = Series("off day", anchor: "2026-10-01", Rule(RecurrenceFrequency.Weekly, interval: 2));

        var result = await Read(Tasks(open, finished, offDay));

        var row = Assert.Single(result.Tasks.Rows);
        Assert.Equal("open", row.Title);
        Assert.Equal("today", row.Section);
        Assert.Equal(new MyDayTaskAction("occurrence", null, Day), row.Action);
        Assert.Equal(Day, row.DueDay);
    }

    [Fact]
    public async Task A_series_with_an_unreadable_rule_or_no_due_day_is_reported()
    {
        var noRule = Task("no rule", due: "2026-10-01") with { RecurrenceJson = "{\"nonsense\":true}" };
        var noAnchor = Series("no anchor", anchor: null, Rule(RecurrenceFrequency.Daily));

        var result = await Read(Tasks(noRule, noAnchor));

        Assert.Empty(result.Tasks.Rows);
        Assert.Equal(new MyDayCoverageReason("invalid_recurrence", 2), Assert.Single(result.Tasks.Coverage.Reasons));
    }

    [Fact]
    public async Task Ceilings_are_reported_with_the_omitted_count_when_it_is_known()
    {
        var many = Enumerable.Range(0, GetMyDayHandler.TaskRowLimit + 3)
            .Select(index => Task($"t{index:D3}", due: "2026-10-16"))
            .ToArray();

        var capped = await Read(Tasks(many) with { Tasks = new MyDayBatch(many, Truncated: true) });

        Assert.Equal(GetMyDayHandler.TaskRowLimit, capped.Tasks.Rows.Count);
        Assert.Equal("partial", capped.Tasks.Coverage.Kind);
        Assert.Equal(
            [new MyDayCoverageReason("candidate_limit", null), new MyDayCoverageReason("row_limit", 3)],
            capped.Tasks.Coverage.Reasons);
    }

    [Fact]
    public async Task The_task_day_follows_the_callers_saved_zone()
    {
        // 23:30 UTC on the 16th is already the 17th in Auckland.
        var clock = new FixedTimeProvider(new DateTimeOffset(2026, 10, 16, 23, 30, 0, TimeSpan.Zero));

        var result = await Read(
            Tasks(Task("today in auckland", due: "2026-10-17")),
            zone: "Pacific/Auckland",
            clock: clock);

        Assert.Equal(new DateOnly(2026, 10, 17), result.TaskDay);
        Assert.Equal("Pacific/Auckland", result.TaskTimezone);
        Assert.Equal("today", Assert.Single(result.Tasks.Rows).Section);
    }

    [Fact]
    public async Task A_workspace_the_caller_cannot_read_is_not_found_and_never_searched()
    {
        var candidates = new FakeCandidates(Tasks());

        var result = await Handler(candidates, new FakeHabits()).HandleAsync(new GetMyDay(Hidden), Cancellation);

        Assert.Equal("workspaces.not_found", result.Error.Code);
        Assert.Equal(0, candidates.Reads);
    }

    [Fact]
    public async Task A_failed_candidate_statement_fails_the_whole_read()
    {
        var candidates = new FakeCandidates(Tasks()) { Failure = new ItemQueryFailedException(timedOut: true, "57014", new InvalidOperationException()) };

        var result = await Handler(candidates, new FakeHabits()).HandleAsync(new GetMyDay(Workspace), Cancellation);

        Assert.Equal("query.timed_out", result.Error.Code);
    }

    [Fact]
    public async Task A_habit_is_read_on_its_own_local_day_and_kept_with_that_date()
    {
        // 12:00 UTC on the 16th is the 17th in Kiritimati (+14), so the habit's day is not the task day.
        var habit = Habit("stretch", "Pacific/Kiritimati");
        var habits = new FakeHabits().Active(habit.Id, new DateOnly(2026, 10, 17));

        var result = await Read(Tasks() with { Habits = new MyDayBatch([habit], false) }, habits: habits);

        var row = Assert.Single(result.Habits.Rows);
        Assert.Equal(Day, result.TaskDay);
        Assert.Equal(new DateOnly(2026, 10, 17), row.Occurrence.Date);
        Assert.Equal((new DateOnly(2026, 10, 17), new DateOnly(2026, 10, 17)), habits.Asked[habit.Id]);
        Assert.Equal("complete", result.Habits.Coverage.Kind);
    }

    [Fact]
    public async Task Paused_unscheduled_locked_and_broken_habits_get_no_row_and_the_unreadable_ones_say_why()
    {
        var paused = Habit("paused", "UTC");
        var unscheduled = Habit("unscheduled", "UTC");
        var locked = Habit("locked", "UTC");
        var broken = Habit("broken", "UTC");
        var malformed = new MyDayCandidate(ItemId.From(Guid.NewGuid()), Workspace, null, null, "malformed", "{\"$habit_frequency\":\"daily\"}", null);
        var habits = new FakeHabits()
            .Active(paused.Id, Day, status: "paused")
            .Active(unscheduled.Id, Day, scheduled: false)
            .Fail(locked.Id, "items.locked")
            .Fail(broken.Id, "habits.invalid_history");

        var result = await Read(Tasks() with { Habits = new MyDayBatch([paused, unscheduled, locked, broken, malformed], false) }, habits: habits);

        Assert.Empty(result.Habits.Rows);
        Assert.Equal("partial", result.Habits.Coverage.Kind);
        Assert.Equal(
            [new MyDayCoverageReason("habit_locked", 1), new MyDayCoverageReason("invalid_habit", 2)],
            result.Habits.Coverage.Reasons);
    }

    private static async Task<MyDayResponse> Read(
        MyDayCandidates candidates,
        string? zone = null,
        FakeHabits? habits = null,
        TimeProvider? clock = null)
    {
        var result = await Handler(new FakeCandidates(candidates), habits ?? new FakeHabits(), zone, clock)
            .HandleAsync(new GetMyDay(Workspace), Cancellation);

        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        return result.Value;
    }

    private static GetMyDayHandler Handler(
        FakeCandidates candidates,
        FakeHabits habits,
        string? zone = null,
        TimeProvider? clock = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IQueryHandler<ReadHabitTracker, Result<HabitTrackerResponse>>>(habits);

        return new GetMyDayHandler(
            StubTree.With([], Workspace),
            new StubPermissions([Workspace]),
            new StubSession(NixSessionContext.ForTenant(Tenant, Caller)),
            new StubPreferences(zone),
            candidates,
            new SchemaByItem(),
            new NixDispatcher(services.BuildServiceProvider()),
            new QueryConcurrencyLimiter(),
            clock ?? new FixedTimeProvider(Now));
    }

    private static MyDayCandidates Tasks(params MyDayCandidate[] tasks) =>
        new(new MyDayBatch(tasks, false), new MyDayBatch([], false));

    private static MyDayCandidate Task(
        string title,
        string? due = null,
        string? assignee = null,
        string? completion = null,
        string? start = null,
        PropertySchema? schema = null)
    {
        var bag = new JsonObject();
        if (due is not null)
        {
            bag["due_date"] = due;
        }

        if (assignee is not null)
        {
            bag["assignee"] = assignee;
        }

        if (completion is not null)
        {
            bag["completion"] = JsonNode.Parse(completion);
        }

        if (start is not null)
        {
            bag["start_date"] = start;
        }

        var id = ItemId.From(Guid.NewGuid());
        SchemaByItem.Schemas[id] = schema ?? TaskSchema();
        return new MyDayCandidate(id, Workspace, null, "Inbox", title, bag.ToJsonString(), null);
    }

    private static MyDayCandidate Series(string title, string? anchor, RecurrenceRule rule) =>
        Task(title, due: anchor) with { RecurrenceJson = RecurrenceRuleJson.Write(rule) };

    private static RecurrenceRule Rule(RecurrenceFrequency frequency, int interval = 1) =>
        new(frequency, interval, [], null, null, []);

    private static MyDayCandidate Habit(string title, string zone)
    {
        var settings = new HabitSettings("daily", [], zone, new DateOnly(2026, 1, 1), 1, "times");
        return new MyDayCandidate(ItemId.From(Guid.NewGuid()), Workspace, null, "Habits", title, settings.ToProperties().ToJsonString(), null);
    }

    private static PropertySchema TaskSchema() => new()
    {
        Properties =
        [
            Field("completion", PropertyType.Completion),
            Field("due_date", PropertyType.DueDate),
            Field("start_date", PropertyType.StartDate),
            Field("assignee", PropertyType.Assignee),
        ],
        Inherit = true,
    };

    // The same keys, declared as ordinary fields: a spelling is not a role.
    private static PropertySchema Plain() => new()
    {
        Properties = [Field("completion", PropertyType.Checkbox), Field("due_date", PropertyType.Date)],
        Inherit = true,
    };

    private static PropertyDefinition Field(string key, PropertyType type) =>
        new(key, key, type, ImmutableArray<string>.Empty, Required: false);

    private sealed class SchemaByItem : ISchemaResolver
    {
        // Shared by the fixture helpers above; each test uses fresh ids, so entries never collide.
        internal static readonly Dictionary<ItemId, PropertySchema> Schemas = [];

        public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Schemas.GetValueOrDefault(itemId, PropertySchema.Empty));

        public ValueTask<PropertySchema> ResolveForChildrenAsync(ItemId? parentId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(PropertySchema.Empty);
    }

    private sealed class FakeCandidates(MyDayCandidates found) : IMyDayCandidates
    {
        public int Reads { get; private set; }

        public ItemQueryFailedException? Failure { get; init; }

        public ValueTask<MyDayCandidates> ReadAsync(
            WorkspaceId workspaceId,
            PrincipalId principalId,
            DateOnly today,
            int taskLimit,
            int habitLimit,
            CancellationToken cancellationToken)
        {
            Reads++;
            return Failure is null ? ValueTask.FromResult(found) : throw Failure;
        }
    }

    private sealed class FakeHabits : IQueryHandler<ReadHabitTracker, Result<HabitTrackerResponse>>
    {
        private readonly Dictionary<ItemId, Result<HabitTrackerResponse>> _answers = [];

        public Dictionary<ItemId, (DateOnly? From, DateOnly? To)> Asked { get; } = [];

        public FakeHabits Active(ItemId id, DateOnly day, string status = "active", bool scheduled = true)
        {
            var occurrence = new HabitOccurrence(day, scheduled, scheduled ? "scheduled" : "unscheduled", 1, "times", null, false);
            _answers[id] = Result.Success(new HabitTrackerResponse(
                id.Value, "daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "times", [], [], status, [occurrence]));
            return this;
        }

        public FakeHabits Fail(ItemId id, string code)
        {
            _answers[id] = Result.Failure<HabitTrackerResponse>(new NixError(code, "refused"));
            return this;
        }

        public ValueTask<Result<HabitTrackerResponse>> HandleAsync(ReadHabitTracker query, CancellationToken cancellationToken)
        {
            Asked[query.ItemId] = (query.From, query.To);
            return ValueTask.FromResult(_answers[query.ItemId]);
        }
    }
}
