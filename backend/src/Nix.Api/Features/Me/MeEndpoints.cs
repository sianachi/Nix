using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Api.Errors;
using Nix.Application.Identity;
using Nix.Core.Primitives;

namespace Nix.Api.Features.Me;

/// <summary>
/// Route registration for the caller's own profile.
/// </summary>
/// <remarks>
/// One route, and it exists for one reason: the shell needs facts about the caller that are
/// deliberately absent from the identity token. Roles live in the database and never in tokens, so
/// "is this person a tenant administrator" cannot be answered client-side by decoding what the
/// client already holds - it has to be asked.
/// </remarks>
internal static class MeEndpoints
{
    /// <summary>Stable code for a session whose principal no longer exists.</summary>
    internal const string PrincipalNotFoundCode = "identity.principal_not_found";

    /// <summary>
    /// Registers the profile route on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapMeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/api/v1/me", GetCurrentPrincipal)
            .WithTags("Me")
            .WithName("GetCurrentPrincipal")
            .WithSummary("The signed-in caller")
            .WithDescription(
                "Returns the caller's identity and whether tenant-wide administrative surfaces "
                + "apply to them. 'isTenantAdministrator' is a display hint for deciding what to "
                + "offer, never a grant: every administrative endpoint checks the same fact "
                + "against the database for itself. The flag is read from the database on each "
                + "request rather than from a token claim, because a role inside a bearer token "
                + "cannot be revoked before the token expires.")
            .Produces<CurrentPrincipalResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    private static async Task<Results<Ok<CurrentPrincipalResponse>, ProblemHttpResult>> GetCurrentPrincipal(
        HttpContext httpContext,
        [FromServices] Application.Identity.GetCurrentPrincipal getCurrentPrincipal)
    {
        var result = await getCurrentPrincipal
            .ExecuteAsync(httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<CurrentPrincipalResponse>, ProblemHttpResult>>(
            principal => TypedResults.Ok(
                new CurrentPrincipalResponse(
                    principal.Id.Value,
                    principal.TenantId.Value,
                    principal.DisplayName,
                    principal.Email,
                    principal.IsTenantAdministrator)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error) =>
        ApiProblem.Create(
            httpContext,
            StatusCodes.Status404NotFound,
            error.Code,
            "Request refused",
            error.Message);
}
