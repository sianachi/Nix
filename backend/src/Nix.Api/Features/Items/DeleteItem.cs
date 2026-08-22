using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Marks an item deleted, leaving its subtree intact.</summary>
/// <param name="ItemId">The item.</param>
/// <remarks>
/// <para>
/// <b>Soft deletion is one flag on one row, never a cascade.</b> Descendants disappear from
/// listings because a listing walks down from a visible parent, not because anything rewrote them,
/// which is what makes restoring a single flip back rather than a reconstruction from a log. It is
/// also what makes deleting a folder of ten thousand notes cost the same as deleting one note.
/// </para>
/// <para>
/// Purging is a separate, retention-driven operation and is not reachable from here. An item this
/// use case has deleted is still stored, still counted against quota, and still restorable until
/// the retention window closes over it.
/// </para>
/// </remarks>
public sealed record DeleteItem(ItemId ItemId) : ICommand<ItemId>;

/// <summary>Marks an item deleted, leaving its subtree intact.</summary>
/// <remarks>
/// <para>
/// <b>Soft deletion is one flag on one row, never a cascade.</b> Descendants disappear from
/// listings because a listing walks down from a visible parent, not because anything rewrote them,
/// which is what makes restoring a single flip back rather than a reconstruction from a log. It is
/// also what makes deleting a folder of ten thousand notes cost the same as deleting one note.
/// </para>
/// <para>
/// Purging is a separate, retention-driven operation and is not reachable from here. An item this
/// use case has deleted is still stored, still counted against quota, and still restorable until
/// the retention window closes over it.
/// </para>
/// </remarks>
public sealed class DeleteItemHandler : ICommandHandler<DeleteItem, ItemId>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="DeleteItemHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public DeleteItemHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);

        _tree = tree;
        _permissions = permissions;
        _session = session;
        _clock = clock;
    }

    /// <summary>Deletes the item.</summary>
    /// <param name="command">The item to delete.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The deleted item's identifier, or why it could not be deleted.</returns>
    /// <remarks>
    /// Deleting an already-deleted item succeeds. The caller asked for a state, the state holds, and
    /// a client retrying after a dropped response should not be told its second attempt was wrong.
    /// </remarks>
    public async ValueTask<Result<ItemId>> HandleAsync(DeleteItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var visible = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        var item = visible
            ?? await _tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        // A directly deleted row remains addressable here for an idempotent retry. An active row
        // hidden below a deleted ancestor does not: being able to mutate it by guessing its id
        // would contradict the visibility boundary every ordinary read and collaboration session
        // observes.
        if (item.LifecycleState == ItemLifecycleState.Active && visible is null)
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<ItemId>(
                ItemErrors.LifecycleConflict("A purged item cannot be deleted; it is already gone."));
        }

        if (item.LifecycleState == ItemLifecycleState.Deleted)
        {
            return Result.Success(itemId);
        }

        await _tree
            .SetLifecycleAsync(
                itemId,
                ItemLifecycleState.Deleted,
                context.PrincipalId,
                _clock.GetUtcNow(),
                cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(itemId);
    }
}

/// <summary>
/// Route handler for soft-deleting an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="DeleteItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapDelete</c> call site.
/// </remarks>
internal static class DeleteItemEndpoint
{
    /// <summary>Handles a request to soft-delete an item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>No content, or a problem describing why it could not be deleted.</returns>
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(itemId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        // No body on success, including when the item was already deleted. The status is the whole
        // answer, and a client retrying after a dropped response gets the same one.
        return result.Match<Results<NoContent, ProblemHttpResult>>(
            _ => TypedResults.NoContent(),
            error => TypedResults.Problem(ItemEndpoints.Problem(httpContext, error)));
    }
}
