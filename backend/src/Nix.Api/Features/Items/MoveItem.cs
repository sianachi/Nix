using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Moves an item to a new parent, at a chosen position among its new siblings.</summary>
/// <param name="ItemId">The item to move.</param>
/// <param name="NewParentId">The new parent, or <see langword="null"/> for the workspace root.</param>
/// <param name="AfterId">
/// The sibling to sit immediately after, or <see langword="null"/> to sit first.
/// </param>
/// <remarks>
/// <para>
/// The one operation that can corrupt the tree, so it is the one with the most checks. A move into
/// the item's own subtree would produce a cycle: a set of rows reachable only from each other, no
/// longer under any workspace root, invisible to every listing and impossible to delete through the
/// interface. The closure table makes that question a single indexed lookup rather than a walk, and
/// it is asked before anything is written.
/// </para>
/// <para>
/// Placement is expressed as "after this sibling" rather than as an index, because an index is a
/// claim about a list the client last saw and a sibling identifier is a claim about a relationship
/// that is still meaningful when the list has changed underneath it.
/// </para>
/// </remarks>
public sealed record MoveItem(ItemId ItemId, ItemId? NewParentId, ItemId? AfterId) : ICommand<Item>;

/// <summary>Moves an item to a new parent, at a chosen position among its new siblings.</summary>
/// <remarks>
/// <para>
/// The one operation that can corrupt the tree, so it is the one with the most checks. A move into
/// the item's own subtree would produce a cycle: a set of rows reachable only from each other, no
/// longer under any workspace root, invisible to every listing and impossible to delete through the
/// interface. The closure table makes that question a single indexed lookup rather than a walk, and
/// it is asked before anything is written.
/// </para>
/// <para>
/// Placement is expressed as "after this sibling" rather than as an index, because an index is a
/// claim about a list the client last saw and a sibling identifier is a claim about a relationship
/// that is still meaningful when the list has changed underneath it.
/// </para>
/// </remarks>
public sealed class MoveItemHandler : ICommandHandler<MoveItem, Item>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;
    private readonly IItemLocks _locks;
    private readonly IFinanceMutationGuard? _financeGuard;

    /// <summary>Initializes a new instance of the <see cref="MoveItemHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    /// <param name="locks">Keeps an item from being moved across the edge of a closed lock.</param>
    /// <param name="financeGuard">Refuses moves that would break a finance workbook, when present.</param>
    public MoveItemHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock,
        IItemLocks locks,
        IFinanceMutationGuard? financeGuard = null)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(locks);

        _tree = tree;
        _permissions = permissions;
        _session = session;
        _clock = clock;
        _locks = locks;
        _financeGuard = financeGuard;
    }

    /// <summary>Moves the item.</summary>
    /// <param name="command">
    /// The item to move; the new parent, or <see langword="null"/> for the workspace root; and the
    /// sibling to sit immediately after, or <see langword="null"/> to sit first.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The moved item, or why it could not be moved.</returns>
    public async ValueTask<Result<Item>> HandleAsync(MoveItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var newParentId = command.NewParentId;
        var afterId = command.AfterId;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }
        var workspaceId = item.WorkspaceId;

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<Item>(ItemErrors.LifecycleConflict("A purged item cannot be moved."));
        }

        if (newParentId is { } destination)
        {
            var parent = await _tree.FindAsync(destination, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != item.WorkspaceId)
            {
                // Cross-workspace moves are not a move; they are a copy and a delete, with their
                // own permission questions on both ends. Refusing here keeps a single operation
                // from quietly becoming that.
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {destination} is visible in this workspace."));
            }

            if (parent.LifecycleState != ItemLifecycleState.Active)
            {
                return Result.Failure<Item>(
                    ItemErrors.LifecycleConflict("An item cannot be moved into a deleted parent."));
            }

            if (destination == itemId
                || await _tree.WouldCreateCycleAsync(itemId, destination, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(
                    ItemErrors.WouldCreateCycle(
                        $"Item {itemId} cannot be moved into itself or into one of its descendants."));
            }

            // Into a closed lock is refused too: the item would vanish from the caller's own view
            // the moment it landed, which reads as the move having lost it.
            if (!await _locks.MayReadBodyAsync(destination, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(
                    ItemErrors.Locked($"Item {destination} is locked. Unlock it before moving anything into it."));
            }
        }

        // A lock covers everything under it, so moving an item out from under a closed lock would
        // open it to anybody who can edit the workspace. Asked of the current parent, not the item:
        // the item's own lock travels with it, so a locked note can still be reordered or filed
        // without being opened; only a lock above it is left behind by the move.
        if (item.ParentId is { } currentParent
            && !await _locks.MayReadBodyAsync(currentParent, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(
                ItemErrors.Locked($"Item {currentParent} is locked. Unlock it before moving anything out of it."));
        }

        if (_financeGuard is not null)
        {
            var blocked = await _financeGuard.CheckAsync(item.WorkspaceId, itemId, newParentId, true, cancellationToken).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<Item>(blocked.Value);
            }
            item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspaceId)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
            }
            if (newParentId is { } lockedParentId)
            {
                var lockedParent = await _tree.FindAsync(lockedParentId, cancellationToken).ConfigureAwait(false);
                if (lockedParent is null || lockedParent.WorkspaceId != item.WorkspaceId)
                {
                    return Result.Failure<Item>(ItemErrors.ParentNotFound($"No parent {lockedParentId} is visible in this workspace."));
                }
                if (lockedParent.LifecycleState != ItemLifecycleState.Active)
                {
                    return Result.Failure<Item>(ItemErrors.LifecycleConflict("An item cannot be moved into a deleted parent."));
                }
                if (lockedParentId == itemId || await _tree.WouldCreateCycleAsync(itemId, lockedParentId, cancellationToken).ConfigureAwait(false))
                {
                    return Result.Failure<Item>(ItemErrors.WouldCreateCycle($"Item {itemId} cannot be moved into itself or into one of its descendants."));
                }
            }
            if (afterId is { } lockedAnchorId)
            {
                var lockedAnchor = await _tree.FindAsync(lockedAnchorId, cancellationToken).ConfigureAwait(false);
                if (lockedAnchor is null || lockedAnchor.WorkspaceId != item.WorkspaceId || lockedAnchor.ParentId != newParentId || lockedAnchorId == itemId)
                {
                    return Result.Failure<Item>(ItemErrors.SiblingNotInDestination($"Item {lockedAnchorId} is not a child of the destination, so it cannot order the move."));
                }
            }
        }

        if (afterId is { } anchor)
        {
            var sibling = await _tree.FindAsync(anchor, cancellationToken).ConfigureAwait(false);
            if (sibling is null || sibling.WorkspaceId != item.WorkspaceId)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {anchor} is visible."));
            }

            if (sibling.ParentId != newParentId || anchor == itemId)
            {
                // Placing something after a sibling that is not in the destination has no defined
                // meaning. Guessing one - appending, or ignoring the request - would put the item
                // somewhere the caller did not ask for, which is exactly what a drag-and-drop user
                // notices and nobody else does.
                return Result.Failure<Item>(
                    ItemErrors.SiblingNotInDestination(
                        $"Item {anchor} is not a child of the destination, so it cannot order the move."));
            }
        }

        var seq = await _tree
            .AllocateSiblingSequenceAsync(item.WorkspaceId, newParentId, itemId, afterId, cancellationToken)
            .ConfigureAwait(false);

        await _tree
            .ReparentAsync(itemId, newParentId, seq, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        // Re-read rather than patching the shape in memory: the closure rewrite and the row update
        // both went through the store, and inventing what the row now looks like is how a response
        // drifts from the row it claims to describe.
        var moved = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return moved is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the move."))
            : Result.Success(moved);
    }
}

/// <summary>
/// Route handler for moving an item to a new parent.
/// </summary>
/// <remarks>
/// Named apart from <see cref="MoveItem"/> itself: the command record already owns that identifier
/// in this namespace, and a route handler with the same name would be an ambiguous simple name at
/// the <c>MapPost</c> call site.
/// </remarks>
internal static class MoveItemEndpoint
{
    /// <summary>Handles a request to move an item.</summary>
    /// <param name="itemId">The item to move.</param>
    /// <param name="request">The requested new parent and sibling position.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The moved item, or a problem describing why it could not be moved.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        MoveItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<MoveItem, Item>(
                new MoveItem(
                    ItemId.From(itemId),
                    request.ParentId is { } parent ? ItemId.From(parent) : null,
                    request.AfterId is { } after ? ItemId.From(after) : null),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await ItemMapping.RespondAsync(result.Value, dispatcher, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }
}
