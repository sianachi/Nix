using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workspaces;
using Nix.Features.Workspaces;
using Nix.Persistence;

namespace Nix.Tests.Features.Workspaces;

public sealed class WorkspaceArrangementTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceGroupDto Group(string name, params Guid[] workspaces) => new(Guid.NewGuid(), name, workspaces);

    [Fact]
    public void Named_groups_with_each_workspace_placed_once_and_bounded_pins_are_accepted()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        Assert.True(WorkspaceArrangementValidation.IsValid(WorkspaceArrangementValidation.Empty));
        Assert.True(WorkspaceArrangementValidation.IsValid(new([Group("Work", a), Group("Home", b)], [b])));
        Assert.True(WorkspaceArrangementValidation.IsValid(new([], [.. Enumerable.Range(0, 200).Select(_ => Guid.NewGuid())])));
    }

    [Fact]
    public void A_blank_name_a_repeated_group_id_a_workspace_in_two_groups_and_too_many_pins_are_refused()
    {
        var a = Guid.NewGuid();
        var id = Guid.NewGuid();
        Assert.False(WorkspaceArrangementValidation.IsValid(null));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([Group("  ", a)], [])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([Group(new string('x', 81), a)], [])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([new(id, "A", []), new(id, "B", [])], [])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([Group("A", a), Group("B", a)], [])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([Group("A", a, a)], [])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([], [a, a])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([], [.. Enumerable.Range(0, 201).Select(_ => Guid.NewGuid())])));
        Assert.False(WorkspaceArrangementValidation.IsValid(new([.. Enumerable.Range(0, 51).Select(index => Group($"G{index}"))], [])));
    }

    [Fact]
    public async Task A_stale_save_does_not_overwrite_another_devices_edit_and_groups_round_trip()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var store = new MemoryStore();
        var handler = new SaveWorkspaceArrangementHandler(store, session);
        var workspace = Guid.NewGuid();
        var input = new WorkspaceArrangementInput([Group(" Work ", workspace)], [workspace]);

        var first = await handler.HandleAsync(new(0, input), Cancellation);
        var second = await handler.HandleAsync(new(0, WorkspaceArrangementValidation.Empty), Cancellation);
        Assert.True(first.IsSuccess);
        Assert.Equal(1, first.Value.Revision);
        Assert.Equal("Work", Assert.Single(first.Value.Groups).Name);
        Assert.True(second.IsFailure);
        Assert.Equal("workspaces.arrangement_conflict", second.Error.Code);

        var read = await new GetWorkspaceArrangementHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Equal(1, read.Revision);
        Assert.Equal(workspace, Assert.Single(Assert.Single(read.Groups).WorkspaceIds));
        Assert.Equal([workspace], read.PinnedWorkspaceIds);
    }

    [Fact]
    public async Task Reading_before_any_save_is_empty_at_revision_zero_and_a_broken_document_costs_only_the_groups()
    {
        var session = new ScopedNixSessionContextAccessor();
        var context = new NixSessionContext(TenantId.Create(), null, PrincipalId.Create());
        session.Set(context);
        var store = new MemoryStore();
        var empty = await new GetWorkspaceArrangementHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Equal(0, empty.Revision);
        Assert.Empty(empty.Groups);

        var pinned = Guid.NewGuid();
        await store.SaveAsync(new WorkspaceArrangement
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            GroupsJson = "not json",
            PinnedWorkspaceIds = [pinned],
            Revision = 1,
        }, 0, Cancellation);
        var read = await new GetWorkspaceArrangementHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Empty(read.Groups);
        Assert.Equal([pinned], read.PinnedWorkspaceIds);
    }

    private sealed class MemoryStore : IWorkspaceArrangementStore
    {
        private WorkspaceArrangement? _saved;

        public ValueTask<WorkspaceArrangement?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_saved is { } row && row.TenantId == tenantId && row.PrincipalId == principalId ? row : null);

        public Task<bool> SaveAsync(WorkspaceArrangement arrangement, long expectedRevision, CancellationToken cancellationToken)
        {
            if ((_saved?.Revision ?? 0) != expectedRevision)
            {
                return Task.FromResult(false);
            }

            _saved = arrangement;
            return Task.FromResult(true);
        }
    }
}
