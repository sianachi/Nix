using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Templates;
using Nix.Features.Exports;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Internal;

/// <summary>Worker-only, lease-bound file-copy capabilities for template stages.</summary>
internal static class TemplateFileTransferEndpoints
{
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var files = group.MapGroup("/template-file-transfers/{jobId:guid}");
        files.MapGet("/plan", GetPlan);
        files.MapPost("/complete", Complete);
    }

    private static async Task<IResult> GetPlan(
        Guid jobId,
        Guid? afterTransferId,
        int? limit,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] Nix.Abstractions.Templates.ITemplateFileTransferStore transfers,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] TimeProvider clock)
    {
        var executionId = await ExportEndpoints.ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        var scoped = session.Current
            ?? throw new InvalidOperationException("No worker session context was established.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted)
            .ConfigureAwait(false);
        var payload = job is null ? null : ReadPayload(job.Payload);
        if (executionId is null || !signer.IsConfigured || job is null
            || job.Kind != "template.files.copy" || job.Status != "running" || payload is null)
        {
            return TypedResults.Problem(Refused(context));
        }

        var page = await transfers.AuthorizeCopyAsync(
            payload.OwnerKind,
            payload.OwnerId,
            executionId,
            afterTransferId,
            limit ?? 100,
            context.RequestAborted).ConfigureAwait(false);
        if (page is null || page.Transfers.Count == 0)
        {
            return TypedResults.Problem(Refused(context));
        }

        var result = new WorkerTemplateFileTransferPlanResponse(
            jobId,
            payload.OwnerKind,
            payload.OwnerId,
            page.Transfers.Select(transfer =>
            {
                if (transfer.TargetReady)
                {
                    return new WorkerTemplateFileTransferResponse(
                        transfer.TransferId,
                        transfer.SourceItemId,
                        transfer.TargetItemId,
                        transfer.TargetVersion,
                        null,
                        null,
                        null,
                        transfer.FileName,
                        transfer.MediaType,
                        transfer.ByteLength,
                        transfer.Sha256,
                        true);
                }

                var download = signer.Get(transfer.SourceObjectKey);
                var upload = signer.PutImmutableVerifiedForWorker(
                    transfer.TargetObjectKey,
                    transfer.ByteLength,
                    transfer.Sha256);
                var verify = signer.Get(transfer.TargetObjectKey);
                return new WorkerTemplateFileTransferResponse(
                    transfer.TransferId,
                    transfer.SourceItemId,
                    transfer.TargetItemId,
                    transfer.TargetVersion,
                    download.Url,
                    upload.Url,
                    verify.Url,
                    transfer.FileName,
                    transfer.MediaType,
                    transfer.ByteLength,
                    transfer.Sha256,
                    false);
            }).ToArray(),
            clock.GetUtcNow(),
            page.NextAfterTransferId,
            page.Complete);
        return TypedResults.Ok(result);
    }

    private static async Task<IResult> Complete(
        Guid jobId,
        CompleteTemplateFileTransferRequest request,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] Nix.Abstractions.Templates.ITemplateFileTransferStore transfers)
    {
        var executionId = await ExportEndpoints.ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        var scoped = session.Current
            ?? throw new InvalidOperationException("No worker session context was established.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted)
            .ConfigureAwait(false);
        var payload = job is null ? null : ReadPayload(job.Payload);
        if (executionId is null || job is null
            || job.Kind != "template.files.copy" || job.Status != "running" || payload is null)
        {
            return TypedResults.Problem(Refused(context));
        }

        if (!await transfers.CompleteCopyAsync(
            payload.OwnerKind,
            payload.OwnerId,
            executionId,
            request.TransferIds,
            context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(Refused(context));
        }
        return TypedResults.Ok(new WorkerTemplateFileTransferCompleteResponse(jobId, true));
    }

    private static TemplateFileTransferJobPayload? ReadPayload(string payload)
    {
        try
        {
            var value = JsonSerializer.Deserialize(payload, TemplateFileTransfersJsonContext.Default.TemplateFileTransferJobPayload);
            return value is not null
                && value.OwnerId != Guid.Empty
                && value.OwnerKind is "operation" or "application"
                    ? value
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static ProblemDetails Refused(HttpContext context) => Nix.Errors.ApiProblem.Create(
        context,
        StatusCodes.Status404NotFound,
        "template.file_transfer_unavailable",
        "File transfer unavailable",
        "The template file transfer is not available to this worker execution.");
}

internal sealed record TemplateFileTransferJobPayload(string OwnerKind, Guid OwnerId);

internal sealed record WorkerTemplateFileTransferPlanResponse(
    Guid JobId,
    string OwnerKind,
    Guid OwnerId,
    IReadOnlyList<WorkerTemplateFileTransferResponse> Transfers,
    DateTimeOffset ObservedAt,
    Guid? NextAfterTransferId,
    bool Complete);

internal sealed record WorkerTemplateFileTransferResponse(
    Guid TransferId,
    Guid SourceItemId,
    Guid TargetItemId,
    int TargetVersion,
    Uri? DownloadUrl,
    Uri? UploadUrl,
    Uri? VerifyUrl,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Ready);

internal sealed record CompleteTemplateFileTransferRequest(IReadOnlyList<Guid> TransferIds);

internal sealed record WorkerTemplateFileTransferCompleteResponse(Guid JobId, bool Completed);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(TemplateFileTransferJobPayload))]
[JsonSerializable(typeof(WorkerTemplateFileTransferPlanResponse))]
[JsonSerializable(typeof(CompleteTemplateFileTransferRequest))]
[JsonSerializable(typeof(WorkerTemplateFileTransferCompleteResponse))]
internal sealed partial class TemplateFileTransfersJsonContext : JsonSerializerContext;
