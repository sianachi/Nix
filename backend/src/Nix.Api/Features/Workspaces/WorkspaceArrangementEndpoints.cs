using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Workspaces;

/// <summary>The caller's own workspace groups and pins: a personal arrangement, never a permission.</summary>
internal static class WorkspaceArrangementEndpoints
{
    internal static IEndpointRouteBuilder MapWorkspaceArrangementEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var me = endpoints.MapGroup("/api/v1/me").WithTags("Workspaces");
        me.MapGet("/workspace-arrangement", Get)
            .WithName("GetWorkspaceArrangement")
            .WithSummary("The caller's own workspace groups and pins");
        me.MapPut("/workspace-arrangement", Save)
            .WithName("SaveWorkspaceArrangement")
            .WithSummary("Replace the caller's own workspace groups and pins at the version they edited")
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Ok<WorkspaceArrangementResponse>> Get(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher
            .QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), context.RequestAborted)
            .ConfigureAwait(false));

    private static async Task<Results<Ok<WorkspaceArrangementResponse>, ProblemHttpResult>> Save(
        SaveWorkspaceArrangementRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher.SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(
            new(request.ExpectedRevision, request.Arrangement), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<WorkspaceArrangementResponse>, ProblemHttpResult>>(
            saved => TypedResults.Ok(saved),
            error => TypedResults.Problem(ApiProblem.Create(
                context,
                error.Code == "workspaces.arrangement_conflict" ? StatusCodes.Status409Conflict : StatusCodes.Status422UnprocessableEntity,
                error.Code, "The arrangement could not be saved", error.Message)));
    }
}
