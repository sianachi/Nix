using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Bookmarks;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Bookmarks;

/// <summary>
/// Route registration for bookmarks: what one person has kept.
/// </summary>
/// <remarks>
/// <para>
/// The list hangs off <c>/me</c> rather than off a workspace, because a shelf is personal state
/// that crosses workspaces - the same shape <c>/me/canvas-library</c> has, and for the same reason.
/// The writes hang off the item, because that is what is being kept and the identifier is already
/// in the path.
/// </para>
/// <para>
/// <c>PUT</c> and <c>DELETE</c> rather than <c>POST</c> and a body: keeping something is idempotent
/// - pressing the control twice leaves one row - and that is exactly what <c>PUT</c> promises.
/// </para>
/// </remarks>
internal static class BookmarkEndpoints
{
    /// <summary>
    /// Registers the bookmark feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapBookmarkEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var me = endpoints.MapGroup("/api/v1/me").WithTags("Bookmarks");

        me.MapGet("/bookmarks", GetShelfEndpoint.Handle)
            .WithName("GetBookmarks")
            .WithSummary("What the caller has kept")
            .WithDescription(
                "Returns the items the calling principal has bookmarked, most recently kept first. "
                + "A shelf is personal: it belongs to the caller and no request can ask for "
                + "somebody else's. "
                + "Titles are read from the items rather than stored on the bookmark, so a rename "
                + "shows here immediately. "
                + "A bookmark outlives access to what it points at - losing membership of a "
                + "workspace does not remove rows - so this list carries only the items the caller "
                + "may still read, filtered while the query runs. The 'hidden' count says how many "
                + "kept items that left out, without naming them: naming them would disclose the "
                + "titles of documents somebody has been removed from, and omitting them silently "
                + "would be a shelf that loses things without saying so. "
                + "An item that has been moved to the trash is counted as hidden for the same "
                + "reason and by the same rule.")
            .Produces<ShelfResponse>(StatusCodes.Status200OK);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Bookmarks");

        items.MapPut("/{itemId:guid}/bookmark", KeepItemEndpoint.Handle)
            .WithName("KeepItem")
            .WithSummary("Keep an item")
            .WithDescription(
                "Puts an item on the calling principal's shelf. Idempotent: keeping something "
                + "already kept leaves one row and answers the same way. "
                + "Only an item the caller may read can be kept, and the check is a predicate "
                + "inside the insert rather than a separate lookup. An item the caller may not "
                + "read, and an item already kept, both answer 204 - telling them apart would "
                + "answer, for any identifier, whether it names something that exists.")
            .Produces(StatusCodes.Status204NoContent)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapDelete("/{itemId:guid}/bookmark", ReleaseItemEndpoint.Handle)
            .WithName("ReleaseItem")
            .WithSummary("Stop keeping an item")
            .WithDescription(
                "Takes an item off the calling principal's shelf. Idempotent, and deliberately not "
                + "permission-checked: somebody who has lost access to an item must still be able "
                + "to clear it off their own shelf, and refusing would disclose that the row is "
                + "there. It can only ever remove the caller's own row.")
            .Produces(StatusCodes.Status204NoContent)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }
}

/// <summary>Route handler for reading the caller's shelf.</summary>
internal static class GetShelfEndpoint
{
    /// <summary>Handles a shelf request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The shelf.</returns>
    internal static async Task<Ok<ShelfResponse>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .QueryAsync<GetShelf, Result<ShelfResults>>(new GetShelf(), httpContext.RequestAborted)
            .ConfigureAwait(false);

        var shelf = result.Value;
        return TypedResults.Ok(new ShelfResponse(ToResponses(shelf.Items), shelf.Hidden));
    }

    private static KeptItemResponse[] ToResponses(IReadOnlyList<KeptItem> items)
    {
        var responses = new KeptItemResponse[items.Count];
        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            responses[index] = new KeptItemResponse(
                item.ItemId.Value,
                item.Title,
                item.Type,
                item.WorkspaceId.Value,
                item.KeptAt);
        }

        return responses;
    }
}

/// <summary>Route handler for keeping an item.</summary>
internal static class KeepItemEndpoint
{
    /// <summary>Handles a keep request.</summary>
    /// <param name="itemId">The item to keep.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>No content.</returns>
    internal static async Task<NoContent> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        await dispatcher
            .SendAsync<KeepItem, bool>(
                new KeepItem(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        // The same answer whether a row was written, one already existed, or the item is not
        // visible. See the endpoint description: distinguishing them would turn this into a
        // probe for whether an identifier names anything.
        return TypedResults.NoContent();
    }
}

/// <summary>Route handler for releasing an item.</summary>
internal static class ReleaseItemEndpoint
{
    /// <summary>Handles a release request.</summary>
    /// <param name="itemId">The item to release.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>No content.</returns>
    internal static async Task<NoContent> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        await dispatcher
            .SendAsync<ReleaseItem, bool>(
                new ReleaseItem(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.NoContent();
    }
}
