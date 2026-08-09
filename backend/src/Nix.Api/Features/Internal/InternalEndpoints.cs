using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Internal;

/// <summary>
/// Route registration for the service-to-service surface.
/// </summary>
/// <remarks>
/// <para>
/// These routes exist for the collaboration service and for nothing else. They sit behind
/// <see cref="Nix.Authentication.InternalBoundaryMiddleware"/> - a shared secret proves the caller
/// is a trusted service, and the forwarded user token (validated by the same unit-of-work pipeline
/// as every public route) proves on whose behalf it asks. Collaboration forwards the user's own
/// token precisely so this surface cannot be tricked into answering for a different principal.
/// </para>
/// <para>
/// Deliberately absent from the OpenAPI document: <c>backend/openapi/nix-api.json</c> is the
/// public contract the frontend client generates from, and a service-to-service seam published
/// there would invite exactly the callers it must refuse.
/// </para>
/// </remarks>
internal static class InternalEndpoints
{
    /// <summary>
    /// Registers the internal routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapInternalEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/internal").ExcludeFromDescription();

        group.MapGet("/authz/items/{itemId:guid}", GetItemAuthorizationEndpoint.Handle);
        group.MapPost("/items/{itemId:guid}/touched", TouchItemEndpoint.Handle)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>Builds the problem details for a refused internal request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the request was refused.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Every refusal is 404 with the feature's own code: an internal caller that may not act on an
    /// item learns nothing beyond "not visible", the same non-answer the public surface gives.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error) =>
        ApiProblem.Create(
            httpContext,
            StatusCodes.Status404NotFound,
            error.Code,
            "Request refused",
            error.Message);
}
