using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Api.Contracts;
using Nix.Api.Errors;
using Nix.Application.Items;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Tenancy;

namespace Nix.Api.Features.Items;

/// <summary>
/// Route registration for the items feature: the tree, and the operations that reshape it.
/// </summary>
/// <remarks>
/// <para>
/// The failure codes below are the stable part of the contract and are what the frontend switches
/// on, so they are named here rather than invented at each call site.
/// </para>
/// <para>
/// Every route in this group is implemented. The <c>501</c> response each one still declares is
/// left in place deliberately: it is published in <c>backend/openapi/nix-api.json</c>, and removing
/// a declared response is a contract change that belongs in a goal that announces it rather than a
/// side effect of implementing the handlers.
/// </para>
/// </remarks>
internal static class ItemEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    internal const string NotFoundCode = "items.not_found";

    /// <summary>Stable code for "the requested parent does not exist or is not visible".</summary>
    internal const string ParentNotFoundCode = "items.parent_not_found";

    /// <summary>
    /// Stable code for a move whose destination is the item itself or one of its descendants.
    /// </summary>
    internal const string CycleCode = "items.move_would_create_cycle";

    /// <summary>Stable code for an operation that is not valid in the item's lifecycle state.</summary>
    internal const string LifecycleConflictCode = "items.lifecycle_conflict";

    /// <summary>
    /// Stable code for a move ordered after a sibling that is not a child of the destination.
    /// </summary>
    internal const string SiblingNotInDestinationCode = "items.sibling_not_in_destination";

    /// <summary>
    /// Registers the items feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapItemEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Listing hangs off the workspace because a listing is always workspace-scoped; the single
        // item routes do not, because an item identifier is unique on its own and forcing clients
        // to carry the workspace around to fetch one would be ceremony.
        var workspaceItems = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/items")
            .WithTags("Items");

        workspaceItems.MapGet("/", ListItems)
            .WithName("ListItems")
            .WithSummary("Children of a folder, or the workspace root")
            .WithDescription(
                "Returns the items directly under 'parentId', or the workspace's roots when it is "
                + "omitted, in sibling order. Items the caller cannot read are omitted entirely - "
                + "a query result is how you enumerate what exists, so redacted placeholders would "
                + "disclose their existence. Soft-deleted items are excluded unless "
                + "'includeDeleted' is set.")
            .Produces<CursorPage<ItemResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        workspaceItems.MapPost("/", CreateItem)
            .WithName("CreateItem")
            .WithSummary("Create an item")
            .WithDescription(
                "Creates an item under 'parentId', or at the workspace root when it is null. "
                + "Fails with 'items.parent_not_found' when the parent does not exist or is not "
                + "visible to the caller.")
            .Produces<ItemResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        var items = endpoints.MapGroup("/api/v1/items")
            .WithTags("Items");

        items.MapGet("/{itemId:guid}", GetItem)
            .WithName("GetItem")
            .WithSummary("One item")
            .WithDescription(
                "Returns the item, or a problem with code 'items.not_found'. An item the caller "
                + "may not read is reported as not found rather than as forbidden.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        items.MapPatch("/{itemId:guid}", UpdateItem)
            .WithName("UpdateItem")
            .WithSummary("Rename an item")
            .WithDescription("Changes the item's own fields. Moving and deleting are separate operations.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        items.MapPost("/{itemId:guid}/move", MoveItem)
            .WithName("MoveItem")
            .WithSummary("Move an item to a new parent")
            .WithDescription(
                "Reparents the item and maintains the closure table. Fails with "
                + "'items.move_would_create_cycle' when the destination is the item itself or one "
                + "of its own descendants, and with 'items.parent_not_found' when the destination "
                + "is not visible.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        items.MapDelete("/{itemId:guid}", DeleteItem)
            .WithName("DeleteItem")
            .WithSummary("Soft-delete an item")
            .WithDescription(
                "Marks the item deleted. The subtree stays intact and its descendants become "
                + "invisible by derivation rather than being rewritten, so restoring is a single "
                + "flag flip. Purging is a separate, retention-driven operation.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        items.MapPost("/{itemId:guid}/restore", RestoreItem)
            .WithName("RestoreItem")
            .WithSummary("Restore a soft-deleted item")
            .WithDescription(
                "Returns the item to the active state. Fails with 'items.lifecycle_conflict' when "
                + "the item has already been purged, which is not recoverable.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        return endpoints;
    }

    private static async Task<Results<Ok<CursorPage<ItemResponse>>, ProblemHttpResult>> ListItems(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] Application.Items.ListItems listItems,
        [FromServices] Application.Items.ItemsWithChildren itemsWithChildren,
        Guid? parentId = null,
        bool includeDeleted = false,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit)
    {
        var result = await listItems.ExecuteAsync(
            WorkspaceId.From(workspaceId),
            parentId is { } parent ? ItemId.From(parent) : null,
            includeDeleted,
            ItemCursor.Decode(cursor),
            limit,
            httpContext.RequestAborted).ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        var page = result.Value;

        // One question for the whole page. Asked per row it would be a query per item in the tree,
        // which is the shape this exists to avoid - see TreeShapeSql for the measurement.
        var withChildren = await itemsWithChildren
            .ExecuteAsync(
                WorkspaceId.From(workspaceId),
                [.. page.Select(item => item.Id)],
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(
            new CursorPage<ItemResponse>(
                [.. page.Select(item => ItemMapping.ToResponse(item, withChildren.Contains(item.Id)))],
                ItemCursor.NextFrom(page, limit)));
    }

    private static async Task<Results<Created<ItemResponse>, ProblemHttpResult>> CreateItem(
        Guid workspaceId,
        CreateItemRequest request,
        HttpContext httpContext,
        [FromServices] Application.Items.CreateItem createItem)
    {
        var result = await createItem.ExecuteAsync(
            WorkspaceId.From(workspaceId),
            request.Type,
            request.Title,
            request.ParentId is { } parent ? ItemId.From(parent) : null,
            httpContext.RequestAborted).ConfigureAwait(false);

        return result.Match<Results<Created<ItemResponse>, ProblemHttpResult>>(
            // A new item is a leaf by construction - nothing can have been parented to it between
            // the insert and this line - so this is provable rather than worth a query.
            item => TypedResults.Created($"/api/v1/items/{item.Id}", ItemMapping.ToResponse(item, false)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> GetItem(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] Application.Items.GetItem getItem,
        [FromServices] Application.Items.ItemsWithChildren itemsWithChildren)
    {
        var result = await getItem
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await Respond(result.Value, itemsWithChildren, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }

    private static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> UpdateItem(
        Guid itemId,
        UpdateItemRequest request,
        HttpContext httpContext,
        [FromServices] RenameItem renameItem,
        [FromServices] Application.Items.ItemsWithChildren itemsWithChildren)
    {
        var result = await renameItem.ExecuteAsync(
            ItemId.From(itemId),
            request.Title,
            httpContext.RequestAborted).ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await Respond(result.Value, itemsWithChildren, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. Deciding the status here, in
    /// one place, is what stops two endpoints answering the same failure differently.
    /// </remarks>
    private static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            CycleCode or LifecycleConflictCode or SiblingNotInDestinationCode =>
                StatusCodes.Status409Conflict,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    private static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> MoveItem(
        Guid itemId,
        MoveItemRequest request,
        HttpContext httpContext,
        [FromServices] Application.Items.MoveItem moveItem,
        [FromServices] Application.Items.ItemsWithChildren itemsWithChildren)
    {
        var result = await moveItem.ExecuteAsync(
            ItemId.From(itemId),
            request.ParentId is { } parent ? ItemId.From(parent) : null,
            request.AfterId is { } after ? ItemId.From(after) : null,
            httpContext.RequestAborted).ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await Respond(result.Value, itemsWithChildren, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteItem(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] Application.Items.DeleteItem deleteItem)
    {
        var result = await deleteItem
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        // No body on success, including when the item was already deleted. The status is the whole
        // answer, and a client retrying after a dropped response gets the same one.
        return result.Match<Results<NoContent, ProblemHttpResult>>(
            _ => TypedResults.NoContent(),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> RestoreItem(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] Application.Items.RestoreItem restoreItem,
        [FromServices] Application.Items.ItemsWithChildren itemsWithChildren)
    {
        var result = await restoreItem
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await Respond(result.Value, itemsWithChildren, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }

    /// <summary>
    /// Maps one item, asking whether it has children.
    /// </summary>
    /// <remarks>
    /// One indexed probe returning at most a row - see <c>TreeShapeSql</c>. Written once rather
    /// than at each of the four endpoints that return a single existing item, because the failure
    /// mode of forgetting it is not a compile error but a response that says "no children" and
    /// costs the tree its expand control.
    /// </remarks>
    private static async Task<ItemResponse> Respond(
        Core.Items.Item item,
        Application.Items.ItemsWithChildren itemsWithChildren,
        CancellationToken cancellationToken)
    {
        var withChildren = await itemsWithChildren
            .ExecuteAsync(item.WorkspaceId, [item.Id], cancellationToken)
            .ConfigureAwait(false);

        return ItemMapping.ToResponse(item, withChildren.Contains(item.Id));
    }
}
