using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Api.Contracts;
using Nix.Api.Errors;

namespace Nix.Api.Features.Items;

/// <summary>
/// Route registration for the items feature: the tree, and the operations that reshape it.
/// </summary>
/// <remarks>
/// Contract only; see <see cref="ContractStub"/>. The failure codes below are the stable part and
/// are what the frontend switches on, so they are named here rather than invented at each call
/// site.
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

    private static Results<Ok<CursorPage<ItemResponse>>, ProblemHttpResult> ListItems(
        Guid workspaceId,
        HttpContext httpContext,
        Guid? parentId = null,
        bool includeDeleted = false,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit) =>
        ContractStub.NotImplemented(httpContext, "ListItems");

    private static Results<Created<ItemResponse>, ProblemHttpResult> CreateItem(
        Guid workspaceId,
        CreateItemRequest request,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "CreateItem");

    private static Results<Ok<ItemResponse>, ProblemHttpResult> GetItem(
        Guid itemId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "GetItem");

    private static Results<Ok<ItemResponse>, ProblemHttpResult> UpdateItem(
        Guid itemId,
        UpdateItemRequest request,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "UpdateItem");

    private static Results<Ok<ItemResponse>, ProblemHttpResult> MoveItem(
        Guid itemId,
        MoveItemRequest request,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "MoveItem");

    private static Results<NoContent, ProblemHttpResult> DeleteItem(
        Guid itemId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "DeleteItem");

    private static Results<Ok<ItemResponse>, ProblemHttpResult> RestoreItem(
        Guid itemId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "RestoreItem");
}
