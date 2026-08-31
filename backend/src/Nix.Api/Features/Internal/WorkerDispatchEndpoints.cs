using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Persistence.Workers;

namespace Nix.Features.Internal;

/// <summary>Service-authenticated, cross-tenant dispatch over narrow database functions.</summary>
internal static class WorkerDispatchEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapPost("/worker-dispatch/jobs/lease", LeaseJobs);
        group.MapPost("/worker-dispatch/jobs/{jobId:guid}/complete", CompleteJob);
        group.MapPost("/worker-dispatch/outbox/lease", LeaseOutbox);
        group.MapPost("/worker-dispatch/outbox/{eventId:guid}/finish", FinishOutbox);
    }

    private static async Task<Ok<IReadOnlyList<DispatchedWorkerJob>>> LeaseJobs(
        DispatchLeaseRequest request,
        [FromServices] WorkerDispatchStore store,
        CancellationToken cancellationToken) => TypedResults.Ok(
            await store.LeaseJobsAsync(
                request.Kind,
                request.Owner,
                Math.Clamp(request.Limit, 1, 100),
                Math.Clamp(request.LeaseSeconds, 5, 300),
                cancellationToken).ConfigureAwait(false));

    private static async Task<Results<NoContent, Conflict>> CompleteJob(
        Guid jobId,
        DispatchJobCompletion request,
        [FromServices] WorkerDispatchStore store,
        CancellationToken cancellationToken) =>
        await store.CompleteJobAsync(
            jobId,
            request.Owner,
            request.Succeeded,
            request.Result,
            request.ErrorCode,
            request.ErrorDetail,
            cancellationToken).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Conflict();

    private static async Task<Ok<IReadOnlyList<DispatchedOutboxEvent>>> LeaseOutbox(
        DispatchLeaseRequest request,
        [FromServices] WorkerDispatchStore store,
        CancellationToken cancellationToken) => TypedResults.Ok(
            await store.LeaseOutboxAsync(
                request.Kind,
                request.Owner,
                Math.Clamp(request.Limit, 1, 100),
                Math.Clamp(request.LeaseSeconds, 5, 300),
                cancellationToken).ConfigureAwait(false));

    private static async Task<Results<NoContent, Conflict>> FinishOutbox(
        Guid eventId,
        DispatchOutboxCompletion request,
        [FromServices] WorkerDispatchStore store,
        CancellationToken cancellationToken) =>
        await store.FinishOutboxAsync(
            eventId,
            request.Owner,
            request.Succeeded,
            request.Error,
            cancellationToken).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Conflict();
}

public sealed record DispatchLeaseRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record DispatchJobCompletion(string Owner, bool Succeeded, string? Result = null, string? ErrorCode = null, string? ErrorDetail = null);
public sealed record DispatchOutboxCompletion(string Owner, bool Succeeded, string? Error = null);
