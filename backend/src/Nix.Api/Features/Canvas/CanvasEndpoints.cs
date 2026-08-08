using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Messaging;

namespace Nix.Features.Canvas;

/// <summary>
/// Route registration for the caller's own canvas library.
/// </summary>
/// <remarks>
/// Under <c>/api/v1/me</c>, matching where the caller's other self-owned state lives: a library is
/// a principal's personal drawing tool, not a workspace or item resource, so it is asked for and
/// written the same way the caller's own profile is.
/// </remarks>
internal static class CanvasEndpoints
{
    /// <summary>
    /// Registers the canvas library routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapCanvasEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/api/v1/me/canvas-library", GetCanvasLibraryEndpoint.Handle)
            .WithTags("Canvas")
            .WithName("GetCanvasLibrary")
            .WithSummary("The caller's own canvas library")
            .WithDescription(
                "Returns the caller's personal set of reusable Excalidraw shapes, the same shape "
                + "Excalidraw itself stores locally - empty for a caller who has never saved one. "
                + "Available to them on every canvas they open, in every workspace.")
            .Produces<CanvasLibraryResponse>(StatusCodes.Status200OK);

        endpoints.MapPut("/api/v1/me/canvas-library", SaveCanvasLibraryEndpoint.Handle)
            .WithTags("Canvas")
            .WithName("SaveCanvasLibrary")
            .WithSummary("Replace the caller's own canvas library")
            .WithDescription(
                "Replaces the caller's library wholesale with what Excalidraw's onLibraryChange "
                + "reports, which is always the library's complete contents rather than a delta. "
                + "Fails with 'canvas_library.too_large' when the library exceeds the stored bound.")
            .Produces<CanvasLibraryResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        return endpoints;
    }

    /// <summary>Builds the problem details for a failed canvas library write.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the write failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error) =>
        ApiProblem.Create(
            httpContext,
            StatusCodes.Status422UnprocessableEntity,
            error.Code,
            "Request refused",
            error.Message);
}

/// <summary>Route handler for reading the caller's own canvas library.</summary>
internal static class GetCanvasLibraryEndpoint
{
    /// <summary>Handles a request for the caller's own canvas library.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The caller's library.</returns>
    internal static async Task<Ok<CanvasLibraryResponse>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var library = await dispatcher
            .QueryAsync<GetCanvasLibrary, CanvasLibraryItems>(new GetCanvasLibrary(), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(new CanvasLibraryResponse(library.Items));
    }
}

/// <summary>Route handler for replacing the caller's own canvas library.</summary>
internal static class SaveCanvasLibraryEndpoint
{
    /// <summary>Handles a request to replace the caller's own canvas library.</summary>
    /// <param name="request">The library's new contents.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The saved library, or a problem describing why it could not be written.</returns>
    internal static async Task<Results<Ok<CanvasLibraryResponse>, ProblemHttpResult>> Handle(
        SaveCanvasLibraryRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<SaveCanvasLibrary, CanvasLibraryItems>(
                new SaveCanvasLibrary(request.Items),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<CanvasLibraryResponse>, ProblemHttpResult>>(
            library => TypedResults.Ok(new CanvasLibraryResponse(library.Items)),
            error => TypedResults.Problem(CanvasEndpoints.Problem(httpContext, error)));
    }
}
