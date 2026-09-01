using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Workers;

namespace Nix.Features.Internal;

internal static class WorkerOutboxEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapPost("/worker/outbox/lease", Lease);
        group.MapPost("/worker/outbox/{eventId:guid}/ack", Acknowledge);
        group.MapPost("/worker/outbox/{eventId:guid}/fail", Fail);
    }

    private static async Task<Ok<IReadOnlyList<WorkerOutboxEventResponse>>> Lease(
        LeaseWorkerOutboxRequest request,
        [FromServices] IWorkerOutboxStore outbox,
        [FromServices] INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var events = await outbox.LeaseAsync(tenant, request.Owner, request.Kind, Math.Clamp(request.Limit, 1, 100), Math.Clamp(request.LeaseSeconds, 5, 300), cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok<IReadOnlyList<WorkerOutboxEventResponse>>(events.Select(ToResponse).ToArray());
    }

    private static async Task<Results<NoContent, NotFound>> Acknowledge(Guid eventId, [FromServices] IWorkerOutboxStore outbox, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return await outbox.AcknowledgeAsync(tenant, eventId, cancellationToken).ConfigureAwait(false) ? TypedResults.NoContent() : TypedResults.NotFound();
    }

    private static async Task<Results<NoContent, NotFound>> Fail(Guid eventId, FailWorkerOutboxRequest request, [FromServices] IWorkerOutboxStore outbox, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        return await outbox.FailAsync(tenant, eventId, request.Error, cancellationToken).ConfigureAwait(false) ? TypedResults.NoContent() : TypedResults.NotFound();
    }

    private static WorkerOutboxEventResponse ToResponse(WorkerOutboxRecord evt) => new(evt.Id, evt.Kind, evt.Payload, evt.Attempts, evt.AvailableAt);
}

public sealed record LeaseWorkerOutboxRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record FailWorkerOutboxRequest(string Error);
public sealed record WorkerOutboxEventResponse(Guid Id, string Kind, string Payload, int Attempts, DateTimeOffset AvailableAt);
