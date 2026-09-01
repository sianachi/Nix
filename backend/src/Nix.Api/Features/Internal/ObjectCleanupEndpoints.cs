using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Internal;

internal static class ObjectCleanupEndpoints
{
    private const int PageSize = 100;

    internal static void Map(IEndpointRouteBuilder group) =>
        group.MapGet("/object-cleanup", Authorize);

    private static async Task<IResult> Authorize(
        int offset,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured
            || offset < 0
            || !Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return TypedResults.NotFound();
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is not { Kind: ObjectCleanupJobs.Kind, Status: "running" })
        {
            return TypedResults.NotFound();
        }

        ObjectCleanupJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
        }
        catch (JsonException)
        {
            return TypedResults.NotFound();
        }
        if (payload is null
            || string.IsNullOrWhiteSpace(payload.OwnerKind)
            || payload.OwnerId == Guid.Empty
            || payload.ObjectKeys.Count is < 1 or > 10_002
            || offset > payload.ObjectKeys.Count
            || payload.ObjectKeys.Any(key => !ObjectStorageKeys.BelongsTo(scoped.TenantId, key)))
        {
            return TypedResults.NotFound();
        }

        var targets = payload.ObjectKeys
            .Skip(offset)
            .Take(PageSize)
            .Select(key => signer.Delete(key).Url)
            .ToArray();
        var nextOffset = offset + targets.Length;
        return TypedResults.Ok(new ObjectCleanupCapabilityResponse(
            payload.OwnerKind,
            payload.OwnerId,
            payload.NotBefore,
            targets,
            nextOffset < payload.ObjectKeys.Count ? nextOffset : null));
    }
}

public sealed record ObjectCleanupCapabilityResponse(
    string OwnerKind,
    Guid OwnerId,
    DateTimeOffset NotBefore,
    IReadOnlyList<Uri> DeleteUrls,
    int? NextOffset);
