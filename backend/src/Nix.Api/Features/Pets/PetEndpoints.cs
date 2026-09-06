using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Pets;

internal static class PetEndpoints
{
    internal static IEndpointRouteBuilder MapPetEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/me/pets").WithTags("Pets");
        group.MapGet("/settings", Get).WithName("GetPetSettings");
        group.MapPut("/settings", Save).WithName("SavePetSettings")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/connection", () => TypedResults.Ok(new PetConnectionResponse(
            "chatgpt", "unavailable", "ChatGPT connection is not available in this build. Your pet settings can still be saved.", false)))
            .WithName("GetPetConnection");
        return endpoints;
    }

    private static async Task<Ok<PetSettingsResponse>> Get(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetSettingsResponse>, ProblemHttpResult>> Save(
        SavePetSettingsRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(
            new(request.ExpectedRevision, request.Settings), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PetSettingsResponse>, ProblemHttpResult>>(
            settings => TypedResults.Ok(settings),
            error => TypedResults.Problem(ApiProblem.Create(context,
                error.Code == "pets.settings_conflict" ? StatusCodes.Status409Conflict : StatusCodes.Status422UnprocessableEntity,
                error.Code, "Pet settings could not be saved", error.Message)));
    }
}
