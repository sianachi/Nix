using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Items;

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

        workspaceItems.MapGet("/trash", ListTrashEndpoint.Handle)
            .WithName("ListTrash")
            .WithSummary("Recoverable items in the workspace trash")
            .WithDescription("Returns directly deleted items the caller may read, newest first. Descendants hidden by a deleted ancestor are not independently trashed.")
            .Produces<CursorPage<ItemResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        workspaceItems.MapGet("/", ListItemsEndpoint.Handle)
            .WithName("ListItems")
            .WithSummary("Children of an item, or the workspace root")
            .WithDescription(
                "Returns the items directly under 'parentId', or the workspace's roots when it is "
                + "omitted, in sibling order. Items the caller cannot read are omitted entirely - "
                + "a query result is how you enumerate what exists, so redacted placeholders would "
                + "disclose their existence. Soft-deleted items are excluded unless "
                + "'includeDeleted' is set.")
            .Produces<CursorPage<ItemResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        workspaceItems.MapPost("/", CreateItemEndpoint.Handle)
            .WithName("CreateItem")
            .WithSummary("Create an item")
            .WithDescription(
                "Creates an item under 'parentId', or at the workspace root when it is null. "
                + "Fails with 'items.parent_not_found' when the parent does not exist or is not "
                + "visible to the caller.")
            .Produces<ItemResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var items = endpoints.MapGroup("/api/v1/items")
            .WithTags("Items");

        items.MapGet("/{itemId:guid}", GetItemEndpoint.Handle)
            .WithName("GetItem")
            .WithSummary("One item")
            .WithDescription(
                "Returns the item, or a problem with code 'items.not_found'. An item the caller "
                + "may not read is reported as not found rather than as forbidden.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        items.MapPatch("/{itemId:guid}", RenameItemEndpoint.Handle)
            .WithName("UpdateItem")
            .WithSummary("Rename an item")
            .WithDescription("Changes the item's own fields. Moving and deleting are separate operations.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/move", MoveItemEndpoint.Handle)
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
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapDelete("/{itemId:guid}", DeleteItemEndpoint.Handle)
            .WithName("DeleteItem")
            .WithSummary("Soft-delete an item")
            .WithDescription(
                "Marks the item deleted. The subtree stays intact and its descendants become "
                + "invisible by derivation rather than being rewritten, so restoring is a single "
                + "flag flip. Purging is a separate, retention-driven operation.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/restore", RestoreItemEndpoint.Handle)
            .WithName("RestoreItem")
            .WithSummary("Restore a soft-deleted item")
            .WithDescription(
                "Returns the item to the active state. Fails with 'items.lifecycle_conflict' when "
                + "the item has already been purged, which is not recoverable.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapDelete("/{itemId:guid}/purge", PurgeItemEndpoint.Handle)
            .WithName("PurgeItem").WithSummary("Permanently delete a trashed item")
            .Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. Deciding the status here, in
    /// one place, is what stops two endpoints answering the same failure differently.
    /// </remarks>
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            CycleCode or LifecycleConflictCode or SiblingNotInDestinationCode =>
                StatusCodes.Status409Conflict,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
