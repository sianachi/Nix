using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Permissions;

/// <summary>
/// Route registration for item sharing.
/// </summary>
/// <remarks>
/// Contract only; see <see cref="ContractStub"/>. Every response here is a decision the server
/// reached, never the inputs a client could reach its own decision from - see
/// <see cref="ItemPermissionsResponse"/>.
/// </remarks>
internal static class PermissionEndpoints
{
    /// <summary>Stable code for "no such access control entry on this item".</summary>
    internal const string EntryNotFoundCode = "permissions.entry_not_found";

    /// <summary>
    /// Stable code for "the caller may read this item but may not change who else can".
    /// </summary>
    /// <remarks>
    /// Forbidden rather than not-found here, unlike the item routes: the caller has already
    /// demonstrated they can see the item, so refusing with 403 discloses nothing they did not
    /// already know and tells the interface which control to disable.
    /// </remarks>
    internal const string CannotShareCode = "permissions.cannot_share";

    /// <summary>
    /// Registers the sharing routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapPermissionEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var permissions = endpoints.MapGroup("/api/v1/items/{itemId:guid}/permissions")
            .WithTags("Permissions");

        permissions.MapGet("/", GetItemPermissions)
            .WithName("GetItemPermissions")
            .WithSummary("Who can do what with this item")
            .WithDescription(
                "Returns the entries that apply to the item - its own and those inherited from its "
                + "ancestors - together with the calling principal's effective role and whether "
                + "they may change the sharing. The effective role and 'canShare' are server "
                + "decisions; a client must render from them and must never derive its own answer "
                + "from the entries.")
            .Produces<ItemPermissionsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        permissions.MapPut("/entries", UpsertAclEntry)
            .WithName("UpsertAclEntry")
            .WithSummary("Grant or refuse a role on this item")
            .WithDescription(
                "Creates or replaces the entry for the given subject and effect. Fails with "
                + "'permissions.cannot_share' when the caller may see the item but may not "
                + "administer its sharing.")
            .Produces<AclEntryResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        permissions.MapDelete("/entries/{aclEntryId:guid}", DeleteAclEntry)
            .WithName("DeleteAclEntry")
            .WithSummary("Remove an entry from this item")
            .WithDescription(
                "Removes an entry attached to this item. An inherited entry cannot be removed here "
                + "- it belongs to the ancestor it is attached to - and attempting it fails with "
                + "'permissions.entry_not_found'.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    private static Results<Ok<ItemPermissionsResponse>, ProblemHttpResult> GetItemPermissions(
        Guid itemId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "GetItemPermissions");

    private static Results<Ok<AclEntryResponse>, ProblemHttpResult> UpsertAclEntry(
        Guid itemId,
        UpsertAclEntryRequest request,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "UpsertAclEntry");

    private static Results<NoContent, ProblemHttpResult> DeleteAclEntry(
        Guid itemId,
        Guid aclEntryId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "DeleteAclEntry");
}
