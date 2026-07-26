using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Tenancy;

namespace Nix.Application.Items;

/// <summary>
/// Creates an item under a parent, or at the workspace root.
/// </summary>
/// <remarks>
/// The server mints the identifier and chooses the sibling position. A client that could supply
/// either would be able to collide with an item it cannot see - which, in a system where "cannot
/// see" is the security boundary, is a way to learn that the invisible item exists.
/// </remarks>
public sealed class CreateItem
{
    private readonly IItemTree _tree;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="CreateItem"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock, injected so timestamps are controllable in tests.</param>
    public CreateItem(IItemTree tree, INixSessionContextAccessor session, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);

        _tree = tree;
        _session = session;
        _clock = clock;
    }

    /// <summary>Creates the item.</summary>
    /// <param name="workspaceId">The workspace to create it in.</param>
    /// <param name="type">Its kind.</param>
    /// <param name="title">Its display name.</param>
    /// <param name="parentId">The parent, or <see langword="null"/> for a workspace root.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The created item, or why it could not be created.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(
        WorkspaceId workspaceId,
        string type,
        string title,
        ItemId? parentId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(type))
        {
            return Result.Failure<Item>(ItemErrors.NotFound("An item type is required."));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        if (!await _tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            // Not-found rather than forbidden: a workspace the caller cannot see must not be
            // distinguishable from one that does not exist.
            return Result.Failure<Item>(
                ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        if (parentId is { } parent)
        {
            var existing = await _tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (existing is null || existing.WorkspaceId != workspaceId)
            {
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {parent} is visible in this workspace."));
            }
        }

        var now = _clock.GetUtcNow();
        var item = new Item
        {
            Id = ItemId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = workspaceId,
            Type = type,
            ParentId = parentId,
            Seq = await _tree
                .NextSiblingSequenceAsync(workspaceId, parentId, cancellationToken)
                .ConfigureAwait(false),
            Properties = ItemProperties.WithTitle(null, title),
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = context.PrincipalId,
            LastModifiedBy = context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

        await _tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        return Result.Success(item);
    }
}
