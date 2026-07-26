using Nix.Application.Items;
using Nix.Core.Items;
using Nix.Core.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Moving, deleting and restoring, driven through the use cases a request would reach.
/// </summary>
/// <remarks>
/// The closure property test already proves the tree and its derived edges agree after any sequence
/// of moves. What is left is everything around that: the refusals, the sibling ordering, and the
/// claim that soft deletion is reversible. Those are the parts a user meets - dragging a folder into
/// its own child, deleting a note and wanting it back - so they are tested as operations rather than
/// as store calls.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ItemLifecycleTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public ItemLifecycleTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_move_places_the_item_immediately_after_the_named_sibling()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();

            var first = await NewItemAsync(create, "First", null);
            var second = await NewItemAsync(create, "Second", null);
            var third = await NewItemAsync(create, "Third", null);

            var moved = await work.Resolve<MoveItem>()
                .ExecuteAsync(third.Id, null, first.Id, Cancellation);
            Assert.True(moved.IsSuccess);

            var roots = await ListRootsAsync(work);

            Assert.Equal([first.Id, third.Id, second.Id], roots);
        }
    }

    [Fact]
    public async Task A_move_with_no_named_sibling_places_the_item_first()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();
            var move = work.Resolve<MoveItem>();

            var first = await NewItemAsync(create, "First", null);
            var second = await NewItemAsync(create, "Second", null);

            Assert.True((await move.ExecuteAsync(second.Id, null, null, Cancellation)).IsSuccess);

            var roots = await ListRootsAsync(work);
            Assert.Equal(second.Id, roots[0]);
            Assert.Equal(first.Id, roots[1]);
        }
    }

    [Fact]
    public async Task Repeated_placement_at_the_front_keeps_working_after_the_gap_runs_out()
    {
        // Positions are sparse and halving the minimum closes the gap in about ten moves, so this
        // is the only test that reaches the renumber fallback. Without it the fallback is code that
        // has never run, which is the same as code that does not work.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();
            var move = work.Resolve<MoveItem>();

            var items = new List<ItemId>();
            for (var index = 0; index < 4; index++)
            {
                items.Add((await NewItemAsync(create, $"Item {index}", null)).Id);
            }

            // Each pass sends the current last item to the front, so the front gap halves every
            // time and eventually cannot be halved again.
            for (var pass = 0; pass < 20; pass++)
            {
                var subject = items[^1];
                Assert.True((await move.ExecuteAsync(subject, null, null, Cancellation)).IsSuccess);

                items.RemoveAt(items.Count - 1);
                items.Insert(0, subject);

                Assert.Equal(items, await ListRootsAsync(work));
            }
        }
    }

    [Fact]
    public async Task A_move_ordered_after_a_sibling_of_a_different_parent_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();

            var folder = await NewItemAsync(create, "Folder", null);
            var elsewhere = await NewItemAsync(create, "Elsewhere", null);
            var subject = await NewItemAsync(create, "Subject", null);

            var moved = await work.Resolve<MoveItem>()
                .ExecuteAsync(subject.Id, folder.Id, elsewhere.Id, Cancellation);

            Assert.True(moved.IsFailure);
            Assert.Equal("items.sibling_not_in_destination", moved.Error.Code);

            // Refused means unchanged: the item is still where it was, not half-moved.
            var unchanged = await work.Resolve<GetItem>().ExecuteAsync(subject.Id, Cancellation);
            Assert.Null(unchanged.Value.ParentId);
        }
    }

    [Fact]
    public async Task A_move_into_a_deleted_parent_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();

            var folder = await NewItemAsync(create, "Folder", null);
            var subject = await NewItemAsync(create, "Subject", null);

            Assert.True((await work.Resolve<DeleteItem>().ExecuteAsync(folder.Id, Cancellation)).IsSuccess);

            var moved = await work.Resolve<MoveItem>()
                .ExecuteAsync(subject.Id, folder.Id, null, Cancellation);

            Assert.True(moved.IsFailure);
            Assert.Equal("items.lifecycle_conflict", moved.Error.Code);
        }
    }

    [Fact]
    public async Task A_move_into_another_workspace_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var subject = await NewItemAsync(work.Resolve<CreateItem>(), "Subject", null);

            // Beta's item is in another tenant entirely, so this also confirms the refusal happens
            // before anything is written rather than being caught by a constraint afterwards.
            var moved = await work.Resolve<MoveItem>()
                .ExecuteAsync(subject.Id, ItemId.From(M0SchemaSeed.Beta.ItemId), null, Cancellation);

            Assert.True(moved.IsFailure);
            Assert.Equal("items.parent_not_found", moved.Error.Code);
        }
    }

    [Fact]
    public async Task Deleting_hides_an_item_from_listings_and_restoring_brings_it_back()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var subject = await NewItemAsync(work.Resolve<CreateItem>(), "Subject", null);

            Assert.True((await work.Resolve<DeleteItem>().ExecuteAsync(subject.Id, Cancellation)).IsSuccess);
            Assert.DoesNotContain(subject.Id, await ListRootsAsync(work));

            // Still there when asked for deliberately: soft deletion hides, it does not destroy.
            Assert.Contains(subject.Id, await ListRootsAsync(work, includeDeleted: true));

            var restored = await work.Resolve<RestoreItem>().ExecuteAsync(subject.Id, Cancellation);
            Assert.True(restored.IsSuccess);
            Assert.Equal(ItemLifecycleState.Active, restored.Value.LifecycleState);
            Assert.Contains(subject.Id, await ListRootsAsync(work));
        }
    }

    [Fact]
    public async Task Deleting_a_folder_leaves_its_children_in_place()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var create = work.Resolve<CreateItem>();

            var folder = await NewItemAsync(create, "Folder", null);
            var child = await NewItemAsync(create, "Child", folder.Id);

            Assert.True((await work.Resolve<DeleteItem>().ExecuteAsync(folder.Id, Cancellation)).IsSuccess);

            // The child row is untouched: still active, still parented. It disappears from the
            // interface because the walk down stops at the deleted folder, which is what makes
            // restoring the folder a single flag flip rather than a reconstruction.
            var stillThere = await work.Resolve<GetItem>().ExecuteAsync(child.Id, Cancellation);
            Assert.True(stillThere.IsSuccess);
            Assert.Equal(ItemLifecycleState.Active, stillThere.Value.LifecycleState);
            Assert.Equal(folder.Id, stillThere.Value.ParentId);
        }
    }

    [Fact]
    public async Task Deleting_twice_succeeds_the_second_time()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var subject = await NewItemAsync(work.Resolve<CreateItem>(), "Subject", null);
            var delete = work.Resolve<DeleteItem>();

            Assert.True((await delete.ExecuteAsync(subject.Id, Cancellation)).IsSuccess);

            // A client retrying after a dropped response asked for a state, and the state holds.
            Assert.True((await delete.ExecuteAsync(subject.Id, Cancellation)).IsSuccess);
        }
    }

    [Fact]
    public async Task A_purged_item_cannot_be_restored()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var subject = await NewItemAsync(work.Resolve<CreateItem>(), "Subject", null);

            await work.Resolve<IItemTree>().SetLifecycleAsync(
                subject.Id,
                ItemLifecycleState.Purged,
                subject.CreatedBy,
                DateTimeOffset.UtcNow,
                Cancellation);

            var restored = await work.Resolve<RestoreItem>().ExecuteAsync(subject.Id, Cancellation);

            Assert.True(restored.IsFailure);
            Assert.Equal("items.lifecycle_conflict", restored.Error.Code);
        }
    }

    [Fact]
    public async Task None_of_these_operations_reach_an_item_in_another_tenant()
    {
        var betaItem = ItemId.From(M0SchemaSeed.Beta.ItemId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var moved = await work.Resolve<MoveItem>().ExecuteAsync(betaItem, null, null, Cancellation);
            Assert.Equal("items.not_found", moved.Error.Code);

            var deleted = await work.Resolve<DeleteItem>().ExecuteAsync(betaItem, Cancellation);
            Assert.Equal("items.not_found", deleted.Error.Code);

            var restored = await work.Resolve<RestoreItem>().ExecuteAsync(betaItem, Cancellation);
            Assert.Equal("items.not_found", restored.Error.Code);
        }
    }

    private static async Task<Item> NewItemAsync(CreateItem create, string title, ItemId? parentId)
    {
        var result = await create.ExecuteAsync(Workspace, "note", title, parentId, Cancellation);
        Assert.True(result.IsSuccess);
        return result.Value;
    }

    /// <summary>
    /// The workspace roots in sibling order, minus the row the schema seed placed there.
    /// </summary>
    private static async Task<IReadOnlyList<ItemId>> ListRootsAsync(
        NixUnitOfWork work,
        bool includeDeleted = false)
    {
        var seeded = ItemId.From(M0SchemaSeed.Alpha.ItemId);
        var page = await work.Resolve<ListItems>()
            .ExecuteAsync(Workspace, null, includeDeleted, null, 200, Cancellation);

        Assert.True(page.IsSuccess);
        return [.. page.Value.Select(item => item.Id).Where(id => id != seeded)];
    }
}
