using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Features.Operations;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.DocumentImports;

/// <summary>Durable document import orchestration for the signed-in principal: upload, preview, commit and cancel.</summary>
internal static class DocumentImportEndpoints
{
    internal static IEndpointRouteBuilder MapDocumentImportEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var imports = endpoints.MapGroup("/api/v1/imports").WithTags("Imports");
        imports.MapPost("/", Begin)
            .WithName("BeginDocumentImport")
            .Produces<DocumentImportUploadResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapGet("/{importId:guid}", Get)
            .WithName("GetDocumentImport")
            .Produces<DocumentImportResponse>()
            .ProducesProblem(404);
        imports.MapPost("/{importId:guid}/preview", QueuePreview)
            .WithName("PreviewDocumentImport")
            .Produces<OperationResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapGet("/{importId:guid}/preview", AuthorizePreview)
            .WithName("AuthorizeDocumentImportPreview")
            .Produces<DocumentImportPreviewCapabilityResponse>()
            .ProducesProblem(404)
            .ProducesProblem(503);
        imports.MapPost("/{importId:guid}/commit", QueueCommit)
            .WithName("CommitDocumentImport")
            .Produces<OperationResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapDelete("/{importId:guid}", Cancel)
            .WithName("CancelDocumentImport")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Begin(
        BeginDocumentImportRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return DocumentImportProblems.StorageUnavailable(context);
        }
        var format = DocumentImportRules.NormalizeFormat(request.Format);
        if (format.Length == 0
            || !DocumentImportRules.ValidName(request.FileName)
            || !DocumentImportRules.ValidMediaType(request.MediaType)
            || string.IsNullOrWhiteSpace(request.Title)
            || request.Title.Length > 500
            || string.IsNullOrWhiteSpace(request.IdempotencyKey)
            || request.IdempotencyKey.Length > 160
            || request.ByteLength is < 0 or > DocumentImportRules.MaximumBytes)
        {
            return TypedResults.Problem(DocumentImportProblems.Invalid(context, "imports.upload_invalid", "The import metadata is invalid."));
        }
        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        ItemId? parentId = request.ParentId is { } parent ? ItemId.From(parent) : null;
        if (!await permissions.CanWriteWorkspaceAsync(workspaceId, context.RequestAborted).ConfigureAwait(false)
            || !await ValidParent(tree, workspaceId, parentId, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var upload = await files.BeginAsync(
            new BeginFileUpload(
                workspaceId,
                parentId,
                null,
                request.FileName,
                request.MediaType,
                request.ByteLength,
                request.IdempotencyKey,
                FileUploadPurposes.DocumentImport),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.idempotency_conflict", "The idempotency key already belongs to a different upload."));
        }
        var operation = await imports.BeginAsync(
            new BeginDocumentImport(
                workspaceId,
                parentId,
                FileUploadId.From(upload.Id),
                format,
                request.Title.Trim(),
                request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.idempotency_conflict", "The idempotency key already belongs to a different import."));
        }
        var capability = operation.Status == DocumentImportStatuses.PendingUpload
            ? signer.PutSized(upload.ObjectKey, request.ByteLength)
            : null;
        return TypedResults.Ok(new DocumentImportUploadResponse(
            operation.Id,
            operation.Status,
            capability?.Url,
            capability?.ExpiresAt,
            operation.ExpiresAt));
    }

    private static async Task<IResult> Get(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        return operation is null
            ? TypedResults.Problem(DocumentImportProblems.NotFound(context))
            : TypedResults.Ok(DocumentImportMapping.ToResponse(operation));
    }

    private static async Task<IResult> QueuePreview(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        if (operation.PreviewJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PendingUpload)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.preview_not_available", "This import cannot start another preview."));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var payload = JsonSerializer.Serialize(
            new DocumentImportJobPayload(importId),
            DocumentImportsJsonContext.Default.DocumentImportJobPayload);
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(operation.WorkspaceId),
            $"import.preview.{operation.Format}",
            $"import.preview:{importId:D}",
            payload,
            context.RequestAborted).ConfigureAwait(false);
        if (await imports.AttachPreviewJobAsync(
            DocumentImportId.From(importId),
            WorkerJobId.From(job.Id),
            context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.preview_not_available", "This import cannot start another preview."));
        }
        return TypedResults.Accepted(
            $"/api/v1/operations/{job.Id:D}",
            OperationMapping.ToResponse(job));
    }

    private static async Task<IResult> AuthorizePreview(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return DocumentImportProblems.StorageUnavailable(context);
        }
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null
            || operation.PlanSha256 is null
            || operation.PlanByteLength is null
            || operation.Status is DocumentImportStatuses.PendingUpload or DocumentImportStatuses.PreviewQueued)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var capability = signer.Get(operation.PlanObjectKey);
        return TypedResults.Ok(new DocumentImportPreviewCapabilityResponse(
            capability.Url,
            capability.ExpiresAt,
            operation.PlanSha256,
            operation.PlanByteLength.Value));
    }

    private static async Task<IResult> QueueCommit(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        if (operation.CommitJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PreviewReady)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.commit_not_available", "A successful preview is required before commit."));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var payload = JsonSerializer.Serialize(
            new DocumentImportJobPayload(importId),
            DocumentImportsJsonContext.Default.DocumentImportJobPayload);
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(operation.WorkspaceId),
            "import.commit",
            $"import.commit:{importId:D}",
            payload,
            context.RequestAborted).ConfigureAwait(false);
        if (await imports.AttachCommitJobAsync(
            DocumentImportId.From(importId),
            WorkerJobId.From(job.Id),
            context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.Conflict(context, "imports.commit_not_available", "This import cannot start another commit."));
        }
        return TypedResults.Accepted(
            $"/api/v1/operations/{job.Id:D}",
            OperationMapping.ToResponse(job));
    }

    private static async Task<IResult> Cancel(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        foreach (var jobId in new[] { operation.PreviewJobId, operation.CommitJobId })
        {
            if (jobId is { } value)
            {
                await jobs.CancelAsync(
                    scoped.TenantId,
                    scoped.PrincipalId,
                    value,
                    context.RequestAborted).ConfigureAwait(false);
            }
        }
        var cleanup = await imports.CancelAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (cleanup is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        await ObjectCleanupJobs.QueueBatchedAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "document-import",
            importId,
            signer.GetCleanupNotBefore(),
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ExistingOperation(
        Guid jobId,
        HttpContext context,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session)
    {
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        return job is null
            ? TypedResults.Problem(DocumentImportProblems.NotFound(context))
            : TypedResults.Accepted(
                $"/api/v1/operations/{job.Id:D}",
                OperationMapping.ToResponse(job));
    }

    private static async Task<bool> ValidParent(
        IItemTree tree,
        WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken)
    {
        if (parentId is null)
        {
            return true;
        }
        var parent = await tree.FindAsync(parentId.Value, cancellationToken).ConfigureAwait(false);
        return parent is not null && parent.WorkspaceId == workspaceId;
    }
}
