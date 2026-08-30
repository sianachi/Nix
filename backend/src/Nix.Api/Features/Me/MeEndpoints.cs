using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.CurrentUser;

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

        endpoints.MapGet("/api/v1/me", GetCurrentPrincipalEndpoint.Handle)
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

    /// <summary>Builds the problem details for a failed read of the caller's own profile.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the read failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error) =>
        ApiProblem.Create(
            httpContext,
            StatusCodes.Status404NotFound,
            error.Code,
            "Request refused",
            error.Message);
}
