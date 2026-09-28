using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
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
        group.MapGet("/connection", Connection)
            .WithName("GetPetConnection");
        group.MapPost("/runtime", Runtime).WithName("PetRuntime")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .ProducesProblem(StatusCodes.Status409Conflict);
        // Not rate limited by the writes policy: this is a read, and it must never wait behind
        // one, however often the client long-polls it. Cost: NixUnitOfWorkMiddleware keeps a
        // Postgres connection and transaction open for the whole wait (up to 20 s). The worker
        // caps concurrent watches at four per principal and answers the fifth with 429 at once,
        // which is what bounds the connections one person can pin.
        group.MapGet("/runtime/watch", Watch).WithName("WatchPetRuntime")
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
        return endpoints;
    }

    private static Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Connection(
        HttpContext context, [FromServices] PetWorkerClient worker) => Runtime(new("status"), context, worker);

    private static async Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Runtime(
        PetRuntimeRequest request, HttpContext context, [FromServices] PetWorkerClient worker)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await worker.ExecuteAsync(request, context.RequestAborted).ConfigureAwait(false);
        return Respond(result, context);
    }

    private static async Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Watch(
        Guid workspaceId, Guid petId, HttpContext context, [FromServices] PetWorkerClient worker, string? mode = null, long after = 0)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await worker.ExecuteWatchAsync(workspaceId, petId, mode ?? string.Empty, after, context.RequestAborted).ConfigureAwait(false);
        return Respond(result, context);
    }

    private static Results<Ok<PetConnectionResponse>, ProblemHttpResult> Respond(
        Result<PetConnectionResponse> result, HttpContext context) =>
        result.Match<Results<Ok<PetConnectionResponse>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context,
                error.Code == "pets.not_found" ? 404
                    : error.Code == "pets.invalid_request" ? 422
                    : error.Code == "pets.busy" ? 409
                    : error.Code == "pets.too_many_watches" ? 429
                    : 503,
                error.Code, "Companion request failed", error.Message)));

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
