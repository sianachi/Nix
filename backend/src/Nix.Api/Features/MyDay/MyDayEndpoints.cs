using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Query;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.MyDay;

internal static class MyDayEndpoints
{
    internal static IEndpointRouteBuilder MapMyDayEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGroup("/api/v1/workspaces").WithTags("My Day")
            .MapGet("/{workspaceId:guid}/my-day", Handle)
            .WithName("GetMyDay")
            .WithSummary("What the caller should do today in one workspace")
            .WithDescription(
                "Returns the tasks due today, overdue, or assigned to the caller, and the habits "
                + "scheduled today, from the workspace's original items. Nothing is stored or copied: "
                + "each row names its item and an 'action' naming the existing command that finishes "
                + "it (set the completion property, complete a recurrence occurrence, or check in a "
                + "habit on the occurrence's own date). An action is a hint; the command still checks "
                + "permission. "
                + "A task is an item whose effective schema declares a completion field. A task whose "
                + "start day is after today is left out. Repeating tasks appear only as today's open "
                + "occurrence; earlier missed occurrences are not an overdue backlog. "
                + "The caller's current day is computed once from their saved time zone (UTC when "
                + "they saved none) and returned as 'taskDay'. Each habit carries its own local day "
                + "in its occurrence, which can differ from 'taskDay'. "
                + "Every section is bounded and says so: 'coverage' is 'partial' with stable reasons "
                + "when a ceiling was reached or an item could not be judged, and 'omitted' is null "
                + "when the count cannot be known. Zero rows with a partial coverage is not an empty "
                + "day. Rows the caller may not read are excluded while the read runs. A workspace "
                + "the caller may not see is reported as not found. At most four bulk reads run at "
                + "once per person ('query.too_many_in_flight', 429).")
            .Produces<MyDayResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.QueriesPolicyName);

        return endpoints;
    }

    private static async Task<Results<Ok<MyDayResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetMyDay, Result<MyDayResponse>>(new GetMyDay(WorkspaceId.From(workspaceId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<MyDayResponse>, ProblemHttpResult>>(
            day => TypedResults.Ok(day),
            error => TypedResults.Problem(QueryEndpoints.Problem(httpContext, error)));
    }
}
