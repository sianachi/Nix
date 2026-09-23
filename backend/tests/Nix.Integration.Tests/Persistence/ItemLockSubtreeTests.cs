using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// A lock covers its whole subtree: a child of a locked item is locked by it, and a locked item's
/// children list, views and collated calendars stay closed until the lock is opened.
/// </summary>
/// <remarks>
/// The seeded item is the locked folder. Each test files a child under it, and sometimes a
/// grandchild, through the ordinary create command so the closure table is maintained the way it is
/// in production.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ItemLockSubtreeTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    /// <summary>The browser session that sets the lock, and so has it open.</summary>
    private static readonly Guid Locker = new("5b7e0c00-2222-4222-8222-5b7e0c000001");

    /// <summary>Another browser, which has not unlocked anything.</summary>
    private static readonly Guid OtherBrowser = new("5b7e0c00-2222-4222-8222-5b7e0c000002");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Folder => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_child_of_a_locked_item_is_locked_by_it_and_names_it_as_the_lock_to_open()
    {
        var child = await CreateAsync("Child", Folder);
        await LockAsync(Locker, Folder, "hunter22");

        var closed = await StateAsync(OtherBrowser, child);
        Assert.True(closed.Locked);
        Assert.Null(closed.UnlockedUntil);
        Assert.Equal(Folder, closed.LockItemId);
        Assert.False(closed.SelfLocked);

        var open = await StateAsync(Locker, child);
        Assert.True(open.Locked);
        Assert.NotNull(open.UnlockedUntil);
        Assert.Equal(Folder, open.LockItemId);

        var refused = await AuthorizeAsync(OtherBrowser, child);
        Assert.True(refused.IsFailure);
        Assert.Equal(InternalErrors.BodyLockedCode, refused.Error.Code);
        Assert.True((await AuthorizeAsync(Locker, child)).IsSuccess);
        Assert.True((await AuthorizeAsync(null, child)).IsFailure);
    }

    [Fact]
    public async Task Unlocking_the_ancestor_opens_everything_under_it()
    {
        var child = await CreateAsync("Child", Folder);
        var grandchild = await CreateAsync("Grandchild", child);
        await LockAsync(Locker, Folder, "hunter22");

        Assert.True((await AuthorizeAsync(OtherBrowser, grandchild)).IsFailure);

        Assert.True((await UnlockAsync(OtherBrowser, Folder, "hunter22")).IsSuccess);

        Assert.True((await AuthorizeAsync(OtherBrowser, child)).IsSuccess);
        Assert.True((await AuthorizeAsync(OtherBrowser, grandchild)).IsSuccess);
        Assert.NotNull((await StateAsync(OtherBrowser, grandchild)).UnlockedUntil);
    }

    /// <summary>
    /// A child with its own lock inside a locked folder needs both passwords, and the state names
    /// whichever is still closed so the prompt asks for the right one.
    /// </summary>
    [Fact]
    public async Task A_nested_lock_needs_its_own_password_after_the_ancestor_is_opened()
    {
        var child = await CreateAsync("Diary", Folder);
        await LockAsync(Locker, Folder, "outer-pass");
        await LockAsync(Locker, child, "inner-pass");

        // The nearest closed lock is asked for first: the item's own.
        var bothClosed = await StateAsync(OtherBrowser, child);
        Assert.True(bothClosed.SelfLocked);
        Assert.Equal(child, bothClosed.LockItemId);

        // The inner password alone opens the inner lock but not the body: the folder is still shut.
        Assert.True((await UnlockAsync(OtherBrowser, child, "inner-pass")).IsSuccess);
        Assert.True((await AuthorizeAsync(OtherBrowser, child)).IsFailure);
        Assert.Equal(Folder, (await StateAsync(OtherBrowser, child)).LockItemId);

        Assert.True((await UnlockAsync(OtherBrowser, Folder, "outer-pass")).IsSuccess);
        var bothOpen = await StateAsync(OtherBrowser, child);
        Assert.NotNull(bothOpen.UnlockedUntil);
        Assert.Equal(child, bothOpen.LockItemId);
        Assert.True((await AuthorizeAsync(OtherBrowser, child)).IsSuccess);
    }

    [Fact]
    public async Task A_locked_items_children_are_not_listed_until_it_is_unlocked()
    {
        var child = await CreateAsync("Child", Folder);
        await CreateAsync("Grandchild", child);
        await LockAsync(Locker, Folder, "hunter22");

        var refused = await ListAsync(OtherBrowser, Folder);
        Assert.True(refused.IsFailure);
        Assert.Equal("items.locked", refused.Error.Code);

        // The lock reaches down: the child's own children are closed by the folder's lock too.
        var refusedBelow = await ListAsync(OtherBrowser, child);
        Assert.Equal("items.locked", refusedBelow.Error.Code);

        var listed = await ListAsync(Locker, Folder);
        Assert.True(listed.IsSuccess);
        Assert.Equal(child, Assert.Single(listed.Value).Id);

        // The workspace roots are not under any lock, and still list the locked folder itself.
        var roots = await ListAsync(OtherBrowser, null);
        Assert.Contains(roots.Value, item => item.Id == Folder);
    }

    /// <summary>
    /// Moving an item out from under a closed lock would open it to anybody who can edit the
    /// workspace; moving one in would hide it from the mover.
    /// </summary>
    [Fact]
    public async Task Nothing_crosses_the_edge_of_a_lock_the_mover_has_not_opened()
    {
        var child = await CreateAsync("Child", Folder);
        var loose = await CreateAsync("Loose", null);
        await LockAsync(Locker, Folder, "hunter22");

        var outward = await MoveAsync(OtherBrowser, child, null);
        Assert.Equal("items.locked", outward.Error.Code);

        var inward = await MoveAsync(OtherBrowser, loose, Folder);
        Assert.Equal("items.locked", inward.Error.Code);

        // The locked item's own lock travels with it, so it can be filed without being opened.
        Assert.True((await MoveAsync(OtherBrowser, Folder, loose)).IsSuccess);

        // Whoever has the lock open may move things across it.
        Assert.True((await MoveAsync(Locker, child, null)).IsSuccess);
    }

    [Fact]
    public async Task A_collated_calendar_leaves_out_a_locked_containers_children()
    {
        await ExecuteAsMigratorAsync(
            $$"""
            UPDATE item
               SET views = '{"views":[{"id":"cal","name":"Calendar","kind":"calendar","dateProperty":"due_date"}]}'::jsonb
             WHERE id = {{Literal(M0SchemaSeed.Alpha.ItemId)}}
            """);
        var dated = await CreateAsync("Dentist", Folder, new JsonObject { ["due_date"] = "2026-09-24" });
        await LockAsync(Locker, Folder, "hunter22");

        var closed = await CalendarAsync(OtherBrowser);
        Assert.DoesNotContain(closed.Entries, entry => entry.ItemId == dated);

        var open = await CalendarAsync(Locker);
        Assert.Contains(open.Entries, entry => entry.ItemId == dated);
    }

    [Fact]
    public async Task A_saved_query_leaves_out_items_under_a_lock_but_keeps_the_locked_item()
    {
        var child = await CreateAsync("Inside", Folder);
        var smartList = await CreateAsync("Everything", null);
        await LockAsync(Locker, Folder, "hunter22");

        var closed = await QueryAsync(OtherBrowser, smartList);
        Assert.DoesNotContain(closed.Items, row => row.Id == child);
        Assert.Contains(closed.Items, row => row.Id == Folder);

        var open = await QueryAsync(Locker, smartList);
        Assert.Contains(open.Items, row => row.Id == child);
    }

    [Fact]
    public async Task Derived_paths_treat_an_item_under_a_lock_as_locked()
    {
        var child = await CreateAsync("Child", Folder);
        await LockAsync(Locker, Folder, "hunter22");

        var work = await BeginAsync(null);
        await using (work.ConfigureAwait(false))
        {
            var locks = work.Resolve<IItemLocks>();
            Assert.Contains(child, await locks.LockedAmongAsync([child], Cancellation));
            Assert.True(await locks.AnyInSubtreeAsync(child, Cancellation));

            // The own-lock reads that back setting and removing a password are unchanged.
            Assert.False(await locks.IsLockedAsync(child, Cancellation));
        }
    }

    /// <summary>
    /// Purging moves an item's children up to its parent, out from under its lock, so it needs the
    /// lock open - the rule a move follows.
    /// </summary>
    [Fact]
    public async Task A_locked_folder_cannot_be_purged_by_somebody_who_has_not_opened_it()
    {
        await CreateAsync("Child", Folder);
        await LockAsync(Locker, Folder, "hunter22");
        Assert.True((await SendAsync<DeleteItem, ItemId>(OtherBrowser, new DeleteItem(Folder))).IsSuccess);

        var refused = await SendAsync<PurgeItem, ItemId>(OtherBrowser, new PurgeItem(Folder));
        Assert.Equal("items.locked", refused.Error.Code);

        Assert.True((await SendAsync<PurgeItem, ItemId>(Locker, new PurgeItem(Folder))).IsSuccess);
    }

    /// <summary>A habit's check-ins are its children, so a habit under a closed lock is not read.</summary>
    [Fact]
    public async Task A_habit_inside_a_locked_folder_is_not_read_by_somebody_who_has_not_opened_it()
    {
        var habit = await CreateAsync("Stretch", Folder);
        var configured = await SendAsync<Nix.Features.Habits.SetHabitSettings, Nix.Features.Habits.HabitTrackerResponse>(
            Locker,
            new Nix.Features.Habits.SetHabitSettings(
                habit,
                new Nix.Features.Habits.HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "done")));
        Assert.True(configured.IsSuccess, configured.IsFailure ? configured.Error.Message : string.Empty);
        await LockAsync(Locker, Folder, "hunter22");

        Assert.Equal("items.locked", (await ReadHabitAsync(OtherBrowser, habit)).Error.Code);
        Assert.True((await ReadHabitAsync(Locker, habit)).IsSuccess);
    }

    /// <summary>A rollup is a view of the children, so a closed container folds to nothing.</summary>
    [Fact]
    public async Task A_locked_container_folds_no_rollup_for_somebody_who_has_not_opened_it()
    {
        await CreateAsync("Estimate", Folder, new JsonObject { ["estimate"] = 3 });
        await LockAsync(Locker, Folder, "hunter22");

        Assert.Empty(await FoldAsync(OtherBrowser));
        Assert.NotEmpty(await FoldAsync(Locker));
    }

    /// <summary>
    /// The derived index is fed by a reader that runs with no credential, so it withholds the body
    /// of anything under a lock, and placing the lock re-indexes the subtree so the index drops it.
    /// </summary>
    [Fact]
    public async Task The_search_index_feed_withholds_bodies_under_a_lock_and_is_told_to_reindex_them()
    {
        var child = await CreateAsync("Child", Folder);
        await ExecuteAsMigratorAsync(
            $"""
            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector, body_text)
            VALUES ({Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(child.Value)}, 1, now(),
                    to_tsvector('english', 'secret words'), 'secret words')
            """);
        var queuedBefore = await QueuedEventsForAsync(child);

        Assert.Equal("secret words", await IndexedBodyAsync(child));

        await LockAsync(Locker, Folder, "hunter22");

        Assert.Null(await IndexedBodyAsync(child));
        Assert.True(await QueuedEventsForAsync(child) > queuedBefore);
    }

    private async Task<ItemId> CreateAsync(string title, ItemId? parent, JsonObject? properties = null)
    {
        var created = await SendAsync<CreateItem, Item>(
            Locker,
            new CreateItem(Workspace, "note", title, parent, properties));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        return created.Value.Id;
    }

    private async Task LockAsync(Guid credential, ItemId item, string password)
    {
        var locked = await SendAsync<LockItem, bool>(credential, new LockItem(item, password, null));
        Assert.True(locked.IsSuccess, locked.IsFailure ? locked.Error.Message : string.Empty);
    }

    private async Task<Result<DateTimeOffset>> UnlockAsync(Guid credential, ItemId item, string password) =>
        await SendAsync<UnlockItem, DateTimeOffset>(credential, new UnlockItem(item, password));

    private async Task<Result<Item>> MoveAsync(Guid credential, ItemId item, ItemId? destination) =>
        await SendAsync<MoveItem, Item>(credential, new MoveItem(item, destination, null));

    private async Task<Result<TResult>> SendAsync<TCommand, TResult>(Guid? credential, TCommand command)
        where TCommand : ICommand<TResult>
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TResult>(command, Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    private async Task<ItemLockState> StateAsync(Guid? credential, ItemId item)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetItemLock, Result<ItemLockState>>(new GetItemLock(item), Cancellation);
            Assert.True(result.IsSuccess);
            return result.Value;
        }
    }

    private async Task<Result<ItemAuthorization>> AuthorizeAsync(Guid? credential, ItemId item)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(new GetItemAuthorization(item), Cancellation);
        }
    }

    private async Task<Result<IReadOnlyList<Item>>> ListAsync(Guid credential, ItemId? parent)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                    new ListItems(Workspace, parent, false, null, 50),
                    Cancellation);
        }
    }

    private async Task<Nix.Domain.Calendar.WorkspaceCalendar> CalendarAsync(Guid credential)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IWorkspaceCalendar>().ReadAsync(
                Workspace,
                [Workspace],
                "2026-09-01",
                "2026-09-30",
                100,
                Cancellation);
        }
    }

    private async Task<Nix.Domain.Query.QueryResults> QueryAsync(Guid credential, ItemId smartList)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IItemQuery>().RunAsync(
                smartList,
                [],
                QueryOrder.Recency,
                new DateOnly(2026, 9, 23),
                [Workspace],
                100,
                Cancellation);
        }
    }

    private async Task<IReadOnlyDictionary<ChildAggregateKey, Nix.Domain.Properties.ChildAggregate>> FoldAsync(Guid credential)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IChildAggregates>().FoldAsync(Workspace, [Folder], ["estimate"], Cancellation);
        }
    }

    private async Task<Result<Nix.Features.Habits.HabitTrackerResponse>> ReadHabitAsync(Guid credential, ItemId habit)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<Nix.Features.Habits.ReadHabitTracker, Result<Nix.Features.Habits.HabitTrackerResponse>>(
                    new Nix.Features.Habits.ReadHabitTracker(habit, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 14)),
                    Cancellation);
        }
    }

    private async Task<string?> IndexedBodyAsync(ItemId item)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(
                connection,
                transaction: null,
                $"SELECT body_text FROM nix_read_search_index_body({Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(item.Value)})");
        }
    }

    private async Task<long> QueuedEventsForAsync(ItemId item)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var count = await RawSql.TextAsync(
                connection,
                transaction: null,
                $"SELECT count(*)::text FROM worker_outbox_event WHERE item_id = {Literal(item.Value)}");
            return long.Parse(count ?? "0", CultureInfo.InvariantCulture);
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid? credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        if (credential is { } id)
        {
            work.Resolve<CredentialSessionContext>().Set(id);
        }

        return work;
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
