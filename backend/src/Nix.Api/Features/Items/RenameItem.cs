using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Changes an item's display name.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Title">The new display name.</param>
/// <remarks>
/// The title is one of the item's properties rather than a column of its own, so a rename reads
/// the property bag, replaces one key and writes the whole bag back. Preserving the rest matters:
/// a rename must not silently drop properties a later goal added and this code knows nothing about.
/// </remarks>
public sealed record RenameItem(ItemId ItemId, string Title) : ICommand<Item>;

/// <summary>Changes an item's display name.</summary>
/// <remarks>
/// The title is one of the item's properties rather than a column of its own, so a rename reads
/// the property bag, replaces one key and writes the whole bag back. Preserving the rest matters:
/// a rename must not silently drop properties a later goal added and this code knows nothing about.
/// </remarks>
public sealed class RenameItemHandler : ICommandHandler<RenameItem, Item>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="RenameItemHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public RenameItemHandler(
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

    /// <summary>Renames the item.</summary>
    /// <param name="command">The item, and its new display name.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The renamed item, or why it could not be renamed.</returns>
    public async ValueTask<Result<Item>> HandleAsync(RenameItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var title = command.Title;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A purged item cannot be renamed."));
        }

        var now = _clock.GetUtcNow();
        var properties = ItemProperties.WithTitle(item.Properties, title);

        await _tree
            .UpdatePropertiesAsync(itemId, properties, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);

        // Re-read rather than constructing the updated shape here: the write went through the
        // store, and inventing what the row now looks like is how a response drifts from the row
        // it claims to describe.
        var renamed = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return renamed is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the rename."))
            : Result.Success(renamed);
    }
}

/// <summary>
/// Route handler for renaming an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RenameItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPatch</c> call site.
/// </remarks>
internal static class RenameItemEndpoint
{
    /// <summary>Handles a request to change an item's own fields.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The requested new display name.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The renamed item, or a problem describing why it could not be renamed.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        UpdateItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<RenameItem, Item>(
                new RenameItem(ItemId.From(itemId), request.Title),
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
