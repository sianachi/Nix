using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Workers;
using Nix.Persistence;

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
        [FromServices] NixDbContext database,
        [FromServices] INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.AddSeconds(Math.Clamp(request.LeaseSeconds, 5, 300));
        var query = database.WorkerOutboxEvents.Where(evt => evt.TenantId == tenant && evt.ProcessedAt == null && evt.AvailableAt <= now && (evt.LeaseUntil == null || evt.LeaseUntil < now));
        if (!string.IsNullOrWhiteSpace(request.Kind))
        {
            query = query.Where(evt => evt.Kind == request.Kind);
        }
        var events = await query.OrderBy(evt => evt.AvailableAt).Take(Math.Clamp(request.Limit, 1, 100)).ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var evt in events)
        {
            evt.Attempts++;
            evt.LeaseOwner = request.Owner;
            evt.LeaseUntil = leaseUntil;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok<IReadOnlyList<WorkerOutboxEventResponse>>(events.Select(ToResponse).ToArray());
    }

    private static async Task<Results<NoContent, NotFound>> Acknowledge(Guid eventId, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var changed = await database.WorkerOutboxEvents.Where(evt => evt.TenantId == tenant && evt.Id == WorkerOutboxEventId.From(eventId)).ExecuteUpdateAsync(setters => setters.SetProperty(evt => evt.ProcessedAt, DateTimeOffset.UtcNow).SetProperty(evt => evt.LeaseOwner, (string?)null).SetProperty(evt => evt.LeaseUntil, (DateTimeOffset?)null), cancellationToken).ConfigureAwait(false);
        return changed == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Fail(Guid eventId, FailWorkerOutboxRequest request, [FromServices] NixDbContext database, [FromServices] INixSessionContextAccessor session, CancellationToken cancellationToken)
    {
        var tenant = session.Current?.TenantId ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var evt = await database.WorkerOutboxEvents.SingleOrDefaultAsync(item => item.TenantId == tenant && item.Id == WorkerOutboxEventId.From(eventId), cancellationToken).ConfigureAwait(false);
        if (evt is null)
        {
            return TypedResults.NotFound();
        }
        evt.LastError = request.Error;
        evt.LeaseOwner = null;
        evt.LeaseUntil = null;
        evt.AvailableAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(Math.Max(evt.Attempts * 5, 5), 300));
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static WorkerOutboxEventResponse ToResponse(WorkerOutboxEvent evt) => new(evt.Id.Value, evt.Kind, evt.Payload, evt.Attempts, evt.AvailableAt);
}

public sealed record LeaseWorkerOutboxRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record FailWorkerOutboxRequest(string Error);
public sealed record WorkerOutboxEventResponse(Guid Id, string Kind, string Payload, int Attempts, DateTimeOffset AvailableAt);
