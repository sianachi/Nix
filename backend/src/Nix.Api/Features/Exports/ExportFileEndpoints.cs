using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Exports;

/// <summary>Issues lease-bound object capabilities for lossless archive file entries.</summary>
internal static class ExportFileEndpoints
{
    internal static void MapWorkerExecutions(IEndpointRouteBuilder exports) =>
        exports.MapGet("/files/{itemId:guid}/versions", GetWorkerFileHistory);

    private static async Task<IResult> GetWorkerFileHistory(
        Guid jobId,
        Guid itemId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] IItemTree tree,
        [FromServices] IFileStore files,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] TimeProvider clock)
    {
        var execution = await ExportEndpoints.ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        if (execution is null || !signer.IsConfigured || job is null
            || !ExportEndpoints.TryReadState(job, out var payload, out _)
            || payload.Format != "nix" || job.Status != "running")
        {
            return TypedResults.Problem(Refused(context));
        }

        if (payload.Scope == "item" && itemId != payload.ItemId
            || payload.Scope == "subtree" && !await tree.IsVisibleSubtreeMemberAsync(
                WorkspaceId.From(payload.WorkspaceId),
                ItemId.From(payload.ItemId),
                ItemId.From(itemId),
                context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(Refused(context));
        }
        var history = await files.AuthorizeVersionHistoryAsync(ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        if (history is null)
        {
            return TypedResults.Problem(Refused(context));
        }

        var versions = new WorkerExportFileVersionResponse[history.Count];
        for (var index = 0; index < history.Count; index++)
        {
            var version = history[index];
            var capability = signer.Get(version.ObjectKey);
            versions[index] = new WorkerExportFileVersionResponse(
                version.Version,
                version.Current,
                version.FileName,
                version.MediaType,
                version.ByteLength,
                version.Sha256,
                version.Previewable,
                version.PixelWidth,
                version.PixelHeight,
                capability.Url,
                capability.ExpiresAt);
        }

        if (versions.Any(version => version.ExpiresAt <= clock.GetUtcNow()))
        {
            return TypedResults.Problem(Refused(context));
        }
        return TypedResults.Ok(new WorkerExportFileHistoryResponse(itemId, versions));
    }

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Refused(HttpContext context) =>
        ApiProblem.Create(
            context,
            StatusCodes.Status404NotFound,
            "exports.file_unavailable",
            "File version unavailable",
            "The file version is not available to this export execution.");
}
