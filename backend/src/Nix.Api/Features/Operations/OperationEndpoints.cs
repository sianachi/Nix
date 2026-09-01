using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Http;

namespace Nix.Features.Operations;

internal static class OperationEndpoints
{
    internal static IEndpointRouteBuilder MapOperationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var operations = endpoints.MapGroup("/api/v1/operations").WithTags("Operations");
        operations.MapGet("/{operationId:guid}", Get)
            .WithName("GetOperation")
            .Produces<OperationResponse>()
            .ProducesProblem(404);
        operations.MapPost("/{operationId:guid}/cancel", Cancel)
            .WithName("CancelOperation")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Results<Ok<OperationResponse>, NotFound>> Get(
        Guid operationId,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            context.TenantId,
            context.PrincipalId,
            operationId,
            cancellationToken).ConfigureAwait(false);
        return job is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(OperationMapping.ToResponse(job));
    }

    private static async Task<Results<NoContent, NotFound>> Cancel(
        Guid operationId,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return await jobs.CancelAsync(
            context.TenantId,
            context.PrincipalId,
            operationId,
            cancellationToken).ConfigureAwait(false)
                ? TypedResults.NoContent()
                : TypedResults.NotFound();
    }
}
