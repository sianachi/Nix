using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.MyDay;
using Nix.Features.Properties;
using Nix.Features.Recurrence;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// My Day on real Postgres: task identity from the effective schema, the visibility rules applied
/// before the candidate ceiling, a closed lock withholding both tasks and a habit's history, and
/// each habit read on its own day.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class MyDayIntegrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Password = "hunter22";

    private static readonly Guid Locker = new("6c8f1d00-3333-4333-8333-6c8f1d000001");
    private static readonly Guid OtherBrowser = new("6c8f1d00-3333-4333-8333-6c8f1d000002");

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private ItemId _tasks;
    private ItemId _vault;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);

        _tasks = await CreateAsync("folder", "Tasks", null);
        var schema = await SendAsync<SetItemSchema, PropertySchema>(new SetItemSchema(_tasks, new PropertySchema
        {
            Properties =
            [
                Field("completion", PropertyType.Completion),
                Field("due_date", PropertyType.DueDate),
                Field("assignee", PropertyType.Assignee),
            ],
            Inherit = true,
        }));
        Assert.True(schema.IsSuccess, schema.IsFailure ? schema.Error.Message : string.Empty);

        _vault = await CreateAsync("folder", "Vault", _tasks);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Only_items_under_a_completion_schema_are_tasks_and_finished_ones_are_left_out()
    {
        await CreateTaskAsync("due today", Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        await CreateTaskAsync("overdue", Today.AddDays(-3).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        await CreateTaskAsync("done", Today.AddDays(-3).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), done: true);
        await CreateAsync("note", "dated note, no schema", null, new JsonObject { ["due_date"] = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) });

        var day = (await ReadAsync(Locker)).Value;

        Assert.Equal(["due today", "overdue"], day.Tasks.Rows.Select(row => row.Title));
        Assert.Equal("complete", day.Tasks.Coverage.Kind);
        Assert.Equal("Tasks", day.Tasks.Rows[0].ContainerTitle);
    }

    [Fact]
    public async Task Work_assigned_to_the_caller_appears_dated_later_or_undated_but_not_someone_elses()
    {
        var me = TestTenants.AlphaContext.PrincipalId.ToString();
        var next = Today.AddDays(7).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        await CreateAssignedAsync("mine later", me, next);
        await CreateAssignedAsync("mine undated", me, null);
        await CreateAssignedAsync("theirs", "00000000-0000-4000-8000-000000000042", next);

        var rows = (await ReadAsync(Locker)).Value.Tasks.Rows;

        Assert.Equal(["mine later", "mine undated"], rows.Select(row => row.Title).Order());
        Assert.All(rows, row => Assert.Equal("assigned", row.Section));
    }

    [Fact]
    public async Task A_repeating_task_outside_any_calendar_shows_todays_occurrence_until_it_is_completed()
    {
        var series = await CreateTaskAsync("daily chore", Today.AddDays(-5).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        var set = await SendAsync<SetItemRecurrence, Item>(new SetItemRecurrence(series, new SetRecurrenceRequest("daily", 1, null, null)));
        Assert.True(set.IsSuccess, set.IsFailure ? set.Error.Message : string.Empty);

        var before = (await ReadAsync(Locker)).Value.Tasks.Rows.Single();
        Assert.Equal(new MyDayTaskAction("occurrence", null, Today), before.Action);

        var completed = await SendAsync<CompleteRecurrenceOccurrence, Item>(new CompleteRecurrenceOccurrence(series, Today));
        Assert.True(completed.IsSuccess, completed.IsFailure ? completed.Error.Message : string.Empty);

        Assert.Empty((await ReadAsync(Locker)).Value.Tasks.Rows);
    }

    [Fact]
    public async Task A_closed_lock_withholds_its_subtree_before_the_candidate_ceiling_is_spent()
    {
        var due = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        await CreateTaskAsync("outside", due);
        for (var index = 0; index < 5; index++)
        {
            await CreateTaskAsync($"vaulted {index.ToString(CultureInfo.InvariantCulture)}", due, parent: _vault);
        }

        var locked = await SendAsync<LockItem, bool>(new LockItem(_vault, Password, null));
        Assert.True(locked.IsSuccess, locked.IsFailure ? locked.Error.Message : string.Empty);

        // Five hidden rows sort ahead of or beside the visible one; a ceiling of two must still see it, untruncated.
        var hidden = await CandidatesAsync(OtherBrowser, taskLimit: 2);
        Assert.Equal(["outside"], hidden.Tasks.Rows.Select(row => row.Title));
        Assert.False(hidden.Tasks.Truncated);

        var open = await CandidatesAsync(Locker, taskLimit: 2);
        Assert.True(open.Tasks.Truncated);
        Assert.Equal(2, open.Tasks.Rows.Count);
    }

    [Fact]
    public async Task A_habit_is_shown_on_its_own_day_and_a_locked_habits_history_is_withheld()
    {
        var habit = await CreateAsync("note", "stretch", null);
        var settings = await SendAsync<SetHabitSettings, HabitTrackerResponse>(
            new SetHabitSettings(habit, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "times")));
        Assert.True(settings.IsSuccess, settings.IsFailure ? settings.Error.Message : string.Empty);

        var row = (await ReadAsync(Locker)).Value.Habits.Rows.Single();
        Assert.Equal(habit.Value, row.ItemId);
        Assert.Equal(Today, row.Occurrence.Date);
        Assert.False(row.Occurrence.Completed);

        var checkedIn = await SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
            new SetHabitCheckIn(habit, row.Occurrence.Date, new HabitCheckInRequest(true, null)));
        Assert.True(checkedIn.IsSuccess, checkedIn.IsFailure ? checkedIn.Error.Message : string.Empty);
        Assert.True((await ReadAsync(Locker)).Value.Habits.Rows.Single().Occurrence.Completed);

        var locked = await SendAsync<LockItem, bool>(new LockItem(habit, Password, null));
        Assert.True(locked.IsSuccess, locked.IsFailure ? locked.Error.Message : string.Empty);

        var withheld = (await ReadAsync(OtherBrowser)).Value.Habits;
        Assert.Empty(withheld.Rows);
        Assert.Equal("partial", withheld.Coverage.Kind);
        Assert.Equal(new MyDayCoverageReason("habit_locked", 1), Assert.Single(withheld.Coverage.Reasons));
    }

    private static PropertyDefinition Field(string key, PropertyType type) =>
        new(key, key, type, ImmutableArray<string>.Empty, Required: false);

    private async Task<ItemId> CreateTaskAsync(string title, string due, bool done = false, ItemId? parent = null)
    {
        var bag = new JsonObject { ["due_date"] = due };
        if (done)
        {
            bag["completion"] = true;
        }

        return await CreateAsync("note", title, parent ?? _tasks, bag);
    }

    private Task<ItemId> CreateAssignedAsync(string title, string assignee, string? due)
    {
        var bag = new JsonObject { ["assignee"] = assignee };
        if (due is not null)
        {
            bag["due_date"] = due;
        }

        return CreateAsync("note", title, _tasks, bag);
    }

    private async Task<ItemId> CreateAsync(string type, string title, ItemId? parent, JsonObject? properties = null)
    {
        var created = await SendAsync<CreateItem, Item>(new CreateItem(Workspace, type, title, parent, properties));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        return created.Value.Id;
    }

    private async Task<Result<MyDayResponse>> ReadAsync(Guid credential)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetMyDay, Result<MyDayResponse>>(new GetMyDay(Workspace), Cancellation);
        }
    }

    private async Task<(MyDayBatch Tasks, MyDayBatch Habits)> CandidatesAsync(Guid credential, int taskLimit)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var found = await work.Resolve<IMyDayCandidates>().ReadAsync(
                Workspace,
                TestTenants.AlphaContext.PrincipalId,
                Today,
                taskLimit,
                habitLimit: 24,
                Cancellation);
            return (found.Tasks, found.Habits);
        }
    }

    private async Task<Result<TResult>> SendAsync<TCommand, TResult>(TCommand command)
        where TCommand : ICommand<TResult>
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TResult>(command, Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        work.Resolve<CredentialSessionContext>().Set(credential);
        return work;
    }
}
