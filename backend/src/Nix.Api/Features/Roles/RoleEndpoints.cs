using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Contracts;
using Nix.Errors;

namespace Nix.Features.Roles;

/// <summary>
/// Route registration for the two role layers above item access control: tenant-wide roles and
/// workspace membership.
/// </summary>
/// <remarks>
/// Contract only; see <see cref="ContractStub"/>. Reads only in this goal - granting and revoking
/// arrive with the authorization work, because a write endpoint whose precedence rules are not
/// built yet would publish a contract nobody could reason about.
/// </remarks>
internal static class RoleEndpoints
{
    /// <summary>
    /// Registers the role routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapRoleEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var tenant = endpoints.MapGroup("/api/v1/tenant")
            .WithTags("Roles");

        tenant.MapGet("/roles", ListTenantRoles)
            .WithName("ListTenantRoles")
            .WithSummary("Tenant-wide role holders")
            .WithDescription(
                "Returns who holds a tenant-level role. Visible to tenant administrators; other "
                + "callers receive an empty page rather than a refusal, because whether the "
                + "endpoint refuses is itself information about the caller's standing.")
            .Produces<CursorPage<RoleGrantResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        return endpoints;
    }

    private static Results<Ok<CursorPage<RoleGrantResponse>>, ProblemHttpResult> ListTenantRoles(
        HttpContext httpContext,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit) =>
        ContractStub.NotImplemented(httpContext, "ListTenantRoles");

}
