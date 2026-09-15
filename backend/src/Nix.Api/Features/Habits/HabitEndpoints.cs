using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Habits;

internal static class HabitTrackerEndpoints
{
    internal static IEndpointRouteBuilder MapHabitTrackerEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}/habit").WithTags("Habits");
        group.MapGet("", Read)
            .WithName("GetHabitTracker")
            .Produces<HabitTrackerResponse>()
            .ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapPut("", Set)
            .WithName("SetHabitSettings")
            .Produces<HabitTrackerResponse>()
            .ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/check-ins/{occurredOn}", CheckIn)
            .WithName("SetHabitCheckIn")
            .Produces<HabitCheckInResponse>()
            .ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("/check-ins/{occurredOn}", Undo)
            .WithName("DeleteHabitCheckIn")
            .Produces(204).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/status", SetStatus)
            .WithName("SetHabitStatus")
            .Produces<HabitStatusResponse>()
            .ProducesProblem(404).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Results<Ok<HabitStatusResponse>, ProblemHttpResult>> SetStatus(Guid itemId, HabitStatusRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetHabitStatus, HabitStatusResponse>(new SetHabitStatus(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<HabitStatusResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<HabitTrackerResponse>, ProblemHttpResult>> Read(Guid itemId, DateOnly? from, DateOnly? to, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(new ReadHabitTracker(ItemId.From(itemId), from, to), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<HabitTrackerResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<HabitTrackerResponse>, ProblemHttpResult>> Set(Guid itemId, HabitSettingsRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(new SetHabitSettings(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<HabitTrackerResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<HabitCheckInResponse>, ProblemHttpResult>> CheckIn(Guid itemId, DateOnly occurredOn, HabitCheckInRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(new SetHabitCheckIn(ItemId.From(itemId), occurredOn, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<HabitCheckInResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> Undo(Guid itemId, DateOnly occurredOn, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<UndoHabitCheckIn, ItemId>(new UndoHabitCheckIn(ItemId.From(itemId), occurredOn), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var status = error.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
            : error.Code is "habits.not_configured" or "habits.history_locked" or "habits.invalid_history" or "items.lifecycle_conflict" ? 409 : 422;
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Habit request refused", error.Message));
    }
}
