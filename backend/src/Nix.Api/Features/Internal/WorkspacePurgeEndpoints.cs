using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Tenancy;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Internal;

/// <summary>Completes one lease-bound workspace purge after object storage has been cleaned.</summary>
internal static class WorkspacePurgeEndpoints
{
    internal static void Map(IEndpointRouteBuilder group) =>
        group.MapPost("/workspace-purge/finalize", static async context =>
        {
            var services = context.RequestServices;
            var result = await Finalize(
                context,
                services.GetRequiredService<IWorkerJobStore>(),
                services.GetRequiredService<INixSessionContextAccessor>(),
                services.GetRequiredService<WorkspaceAdministrationStore>()).ConfigureAwait(false);
            await result.ExecuteAsync(context).ConfigureAwait(false);
        });

    private static async Task<IResult> Finalize(
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] WorkspaceAdministrationStore workspaces)
    {
        var scoped = session.Current;
        if (scoped?.WorkspaceId is not { } workspaceId
            || !Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return TypedResults.NotFound();
        }
        var sessionContext = scoped.Value;

        var job = await jobs.GetAsync(sessionContext.TenantId, sessionContext.PrincipalId, jobId, context.RequestAborted)
            .ConfigureAwait(false);
        if (job is not { Kind: ObjectCleanupJobs.Kind, Status: "running" }
            || !IsWorkspacePurge(job.Payload, workspaceId))
        {
            return TypedResults.NotFound();
        }

        return await workspaces.FinalizePurgeAsync(workspaceId, jobId, context.RequestAborted)
            .ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.NotFound();
    }

    private static bool IsWorkspacePurge(string payload, WorkspaceId workspaceId)
    {
        try
        {
            var decoded = JsonSerializer.Deserialize(
                payload,
                ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
            return decoded is { OwnerKind: "workspace-purge" } && decoded.OwnerId == workspaceId.Value;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
