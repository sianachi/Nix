using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Errors;
using Nix.Features.Operations;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.DocumentImports;

internal static class DocumentImportEndpoints
{
    private const long MaximumBytes = 100L * 1024 * 1024;

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

    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var imports = group.MapGroup("/imports/{importId:guid}");
        imports.MapGet("/preview", GetPreviewExecution);
        imports.MapPost("/preview/complete", CompletePreviewExecution);
        imports.MapGet("/commit", GetCommitExecution);
        imports.MapPost("/stage", StageExecution).WithRequestBodyLimit(16L * 1024 * 1024);
        imports.MapGet("/objects/capability", AuthorizeObjectExecution);
        imports.MapPost("/objects/complete", CompleteObjectExecution);
        imports.MapGet("/bodies/authorization", AuthorizeBodiesExecution);
        imports.MapPost("/finalize", FinalizeExecution);
        imports.MapPost("/reject", RejectExecution);
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
            return StorageUnavailable(context);
        }
        var format = NormalizeFormat(request.Format);
        if (format.Length == 0
            || !ValidName(request.FileName)
            || !ValidMediaType(request.MediaType)
            || string.IsNullOrWhiteSpace(request.Title)
            || request.Title.Length > 500
            || string.IsNullOrWhiteSpace(request.IdempotencyKey)
            || request.IdempotencyKey.Length > 160
            || request.ByteLength is < 0 or > MaximumBytes)
        {
            return TypedResults.Problem(Invalid(context, "imports.upload_invalid", "The import metadata is invalid."));
        }
        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        ItemId? parentId = request.ParentId is { } parent ? ItemId.From(parent) : null;
        if (!await permissions.CanWriteWorkspaceAsync(workspaceId, context.RequestAborted).ConfigureAwait(false)
            || !await ValidParent(tree, workspaceId, parentId, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
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
            return TypedResults.Problem(Conflict(context, "imports.idempotency_conflict", "The idempotency key already belongs to a different upload."));
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
            return TypedResults.Problem(Conflict(context, "imports.idempotency_conflict", "The idempotency key already belongs to a different import."));
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
            ? TypedResults.Problem(NotFound(context))
            : TypedResults.Ok(ToResponse(operation));
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
            return TypedResults.Problem(NotFound(context));
        }
        if (operation.PreviewJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PendingUpload)
        {
            return TypedResults.Problem(Conflict(context, "imports.preview_not_available", "This import cannot start another preview."));
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
            return TypedResults.Problem(Conflict(context, "imports.preview_not_available", "This import cannot start another preview."));
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
            return StorageUnavailable(context);
        }
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null
            || operation.PlanSha256 is null
            || operation.PlanByteLength is null
            || operation.Status is DocumentImportStatuses.PendingUpload or DocumentImportStatuses.PreviewQueued)
        {
            return TypedResults.Problem(NotFound(context));
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
            return TypedResults.Problem(NotFound(context));
        }
        if (operation.CommitJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PreviewReady)
        {
            return TypedResults.Problem(Conflict(context, "imports.commit_not_available", "A successful preview is required before commit."));
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
            return TypedResults.Problem(Conflict(context, "imports.commit_not_available", "This import cannot start another commit."));
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
        [FromServices] TimeProvider clock)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(NotFound(context));
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
            return TypedResults.Problem(NotFound(context));
        }
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "document-import",
            importId,
            clock.GetUtcNow().AddMinutes(1),
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> GetPreviewExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind.StartsWith("import.preview.", StringComparison.Ordinal)).ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || execution.Import.Status is not (DocumentImportStatuses.PreviewQueued or DocumentImportStatuses.PreviewReady))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var planUpload = signer.Put(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerDocumentImportPreviewResponse(
            execution.Import.Id,
            execution.Import.Format,
            execution.Import.Title,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            source.Url,
            sourceDelete.Url,
            planUpload.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, planUpload, planDelete)));
    }

    private static async Task<IResult> CompletePreviewExecution(
        Guid importId,
        CompleteDocumentImportPreviewRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (!ValidPreviewResult(request)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind.StartsWith("import.preview.", StringComparison.Ordinal)).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var result = await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.PlanByteLength,
                request.SourceSha256,
                request.ItemCount,
                request.AssetCount,
                JsonSerializer.Serialize(request.Loss, DocumentImportsJsonContext.Default.IReadOnlyListString),
                JsonSerializer.Serialize(request.Omissions, DocumentImportsJsonContext.Default.IReadOnlyListString)),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(ToResponse(result))
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> GetCommitExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || execution.Import.Status is not (DocumentImportStatuses.CommitQueued or DocumentImportStatuses.Staging or DocumentImportStatuses.Completed)
            || execution.Import.PlanSha256 is null
            || execution.Import.PlanByteLength is null
            || execution.Import.SourceSha256 is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var plan = signer.Get(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerDocumentImportCommitResponse(
            execution.Import.Id,
            execution.Import.Format,
            execution.Import.Title,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            execution.Import.PlanSha256,
            execution.Import.PlanByteLength.Value,
            execution.Import.SourceSha256,
            source.Url,
            sourceDelete.Url,
            plan.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, plan, planDelete)));
    }

    private static async Task<IResult> StageExecution(
        Guid importId,
        StageDocumentImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (request.Items.Count is < 1 or > 10_000
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var result = await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.SourceSha256,
                request.Items.Select(ToPlan).ToArray()),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (!await ExecutionStillLive(context, dispatch).ConfigureAwait(false))
        {
            return TypedResults.Problem(ExecutionLost(context));
        }
        return TypedResults.Ok(new DocumentImportStageResponse(
            result.ImportId,
            result.RootItemId,
            result.Items.Select(value => new DocumentImportStageItemResponse(
                value.SourceId,
                value.TargetItemId,
                value.ItemType,
                value.BodyRequired,
                value.ObjectReady)).ToArray()));
    }

    private static async Task<IResult> AuthorizeObjectExecution(
        Guid importId,
        string sourceId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var mapping = await imports.AuthorizeObjectUploadAsync(
            DocumentImportId.From(importId),
            sourceId,
            context.RequestAborted).ConfigureAwait(false);
        if (mapping is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var read = signer.Get(mapping.ObjectKey);
        var upload = signer.PutImmutable(mapping.ObjectKey, mapping.ByteLength);
        var delete = signer.Delete(mapping.ObjectKey);
        return TypedResults.Ok(new DocumentImportObjectCapabilityResponse(
            sourceId,
            read.Url,
            upload.Url,
            delete.Url,
            MinimumExpiry(read, upload, delete)));
    }

    private static async Task<IResult> CompleteObjectExecution(
        Guid importId,
        CompleteDocumentImportObjectRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (request.ByteLength is < 0 or > MaximumBytes
            || !ValidDigest(request.Sha256)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null
            || !await imports.MarkObjectReadyAsync(
                DocumentImportId.From(importId),
                request.SourceId,
                request.ByteLength,
                request.Sha256,
                context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> AuthorizeBodiesExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        if (await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var stage = await imports.AuthorizeBodyWritesAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        var scoped = session.Current;
        if (stage is null || scoped is null || scoped.Value.WorkspaceId is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scope = scoped.Value;
        return TypedResults.Ok(new DocumentImportBodyAuthorizationResponse(
            scope.TenantId.Value,
            scope.PrincipalId.Value,
            scope.WorkspaceId!.Value.Value,
            importId,
            stage.Items.Select(item => new DocumentImportBodyAuthorizationItemResponse(
                item.SourceId,
                item.TargetItemId,
                item.ItemType,
                item.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    private static async Task<IResult> FinalizeExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] IWorkerJobStore workerJobs,
        [FromServices] TimeProvider clock)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false);
        if (execution is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var result = await imports.FinalizeAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (execution.Import.Status != DocumentImportStatuses.Completed)
        {
            var scoped = session.Current
                ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
            await ObjectCleanupJobs.QueueAsync(
                workerJobs,
                scoped.TenantId,
                scoped.PrincipalId,
                WorkspaceId.From(result.WorkspaceId),
                "document-import",
                importId,
                clock.GetUtcNow(),
                [execution.SourceObjectKey, execution.Import.PlanObjectKey],
                context.RequestAborted).ConfigureAwait(false);
        }
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(ToResponse(result))
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> RejectExecution(
        Guid importId,
        RejectDocumentImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] TimeProvider clock)
    {
        if (!ValidFailureCode(request.Code)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind.StartsWith("import.", StringComparison.Ordinal)).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var cleanup = await imports.FailAsync(
            DocumentImportId.From(importId),
            request.Code,
            context.RequestAborted).ConfigureAwait(false);
        if (cleanup is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "document-import",
            importId,
            clock.GetUtcNow().AddSeconds(5),
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<DocumentImportExecutionRecord?> OwnedExecution(
        Guid importId,
        HttpContext context,
        IDocumentImportStore imports,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        Func<string, bool> kindAllowed)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return null;
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is null || job.Status != "running" || !kindAllowed(job.Kind))
        {
            return null;
        }
        DocumentImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                DocumentImportsJsonContext.Default.DocumentImportJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }
        var execution = payload?.ImportId == importId
            ? await imports.GetExecutionAsync(
                DocumentImportId.From(importId),
                context.RequestAborted).ConfigureAwait(false)
            : null;
        if (execution is null
            || (job.Kind == "import.commit"
                ? execution.Import.CommitJobId != jobId
                : execution.Import.PreviewJobId != jobId))
        {
            return null;
        }
        return execution;
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
            ? TypedResults.Problem(NotFound(context))
            : TypedResults.Accepted(
                $"/api/v1/operations/{job.Id:D}",
                OperationMapping.ToResponse(job));
    }

    private static async Task<bool> ExecutionStillLive(
        HttpContext context,
        IWorkerDispatchStore dispatch)
    {
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        return Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId)
            && await dispatch.AuthorizeExecutionAsync(
                jobId,
                executionId,
                context.RequestAborted).ConfigureAwait(false) is not null;
    }

    private static ImportEnvelopePlan ToPlan(StageDocumentImportItemRequest value) => new(
        value.SourceId,
        value.ParentSourceId,
        value.Order,
        value.Title,
        value.ItemType,
        Json(value.Properties),
        Json(value.Schema),
        Json(value.Views),
        value.FinalLifecycleState,
        value.BodyRequired,
        value.File is null
            ? null
            : new ImportFilePlan(
                value.File.SourceKind,
                value.File.AssetPath,
                value.File.FileName,
                value.File.MediaType,
                value.File.ByteLength,
                value.File.Sha256,
                value.File.Previewable,
                value.File.PixelWidth,
                value.File.PixelHeight));

    private static string? Json(JsonElement? value) => value is { ValueKind: JsonValueKind.Object }
        ? value.Value.GetRawText()
        : null;

    private static DocumentImportResponse ToResponse(DocumentImportRecord value) => new(
        value.Id,
        value.WorkspaceId,
        value.UploadId,
        value.ParentId,
        value.Format,
        value.Title,
        value.Status,
        value.PreviewJobId,
        value.CommitJobId,
        value.ItemCount,
        value.AssetCount,
        ParseJson(value.Loss),
        ParseJson(value.Omissions),
        value.RootItemId,
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    private static JsonElement? ParseJson(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        using var document = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 8 });
        return document.RootElement.Clone();
    }

    private static bool ValidPreviewResult(CompleteDocumentImportPreviewRequest value) =>
        ValidDigest(value.PlanSha256)
        && ValidDigest(value.SourceSha256)
        && value.PlanByteLength is > 0 and <= MaximumBytes
        && value.ItemCount is > 0 and <= 10_000
        && value.AssetCount is >= 0 and <= 10_000
        && value.Loss.Count <= 256
        && value.Omissions.Count <= 10_000
        && value.Loss.Concat(value.Omissions).All(entry => entry.Length <= 500);

    private static bool ValidFailureCode(string code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 80
        && code.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_');

    private static bool ValidDigest(string value) =>
        value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ValidName(string value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 255
        && value.IndexOfAny(['/', '\\', '\0']) < 0;

    private static bool ValidMediaType(string value)
    {
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        return separator > 0
            && separator < value.Length - 1
            && value.Length <= 160
            && value.All(character => character is >= (char)0x21 and <= (char)0x7e && character is not ';' and not '\\');
    }

    private static string NormalizeFormat(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Equals("md", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("markdown", StringComparison.OrdinalIgnoreCase))
        {
            return "markdown";
        }
        if (trimmed.Equals("text", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("txt", StringComparison.OrdinalIgnoreCase))
        {
            return "txt";
        }
        foreach (var format in new[] { "pdf", "docx", "nix" })
        {
            if (trimmed.Equals(format, StringComparison.OrdinalIgnoreCase))
            {
                return format;
            }
        }
        return string.Empty;
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

    private static DateTimeOffset MinimumExpiry(params ObjectCapability[] capabilities) =>
        capabilities.Min(value => value.ExpiresAt);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails NotFound(HttpContext context) =>
        ApiProblem.Create(context, 404, "imports.not_found", "Import not found", "No such import is visible.");

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Invalid(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 400, code, "Import refused", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Conflict(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 409, code, "Import conflict", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails ExecutionLost(HttpContext context) =>
        ApiProblem.Create(context, 409, "worker.execution_refused", "Worker execution refused", "The worker no longer owns a live execution for this job.");

    private static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            503,
            "imports.storage_not_configured",
            "Import storage unavailable",
            "Private object storage is not configured for this deployment."));
}
