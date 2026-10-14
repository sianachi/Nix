using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.CurrentUser;

/// <summary>The caller's own synced interface settings: a personal convenience, never a permission.</summary>
internal static class UiSettingsEndpoints
{
    internal static IEndpointRouteBuilder MapUiSettingsEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var me = endpoints.MapGroup("/api/v1/me").WithTags("Me");
        me.MapGet("/ui-settings", Get)
            .WithName("GetUiSettings")
            .WithSummary("The caller's own synced interface settings");
        me.MapPatch("/ui-settings", Patch)
            .WithName("PatchUiSettings")
            .WithSummary("Merge settings into the caller's own; a null value deletes that key")
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Ok<UiSettingsResponse>> Get(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher.QueryAsync<GetUiSettings, UiSettingsResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<UiSettingsResponse>, ProblemHttpResult>> Patch(
        PatchUiSettingsRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher.SendAsync<PatchUiSettings, UiSettingsResponse>(new(request.Settings), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<UiSettingsResponse>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status422UnprocessableEntity,
                error.Code, "Settings could not be saved", error.Message)));
    }
}
