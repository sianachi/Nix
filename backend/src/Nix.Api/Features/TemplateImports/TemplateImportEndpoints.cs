using System.Security.Cryptography;
using System.Text;
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
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Errors;
using Nix.Features.Operations;
using Nix.Features.Templates;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.TemplateImports;

/// <summary>Durable user and managed template archive orchestration.</summary>
internal static class TemplateImportEndpoints
{
    private const long MaximumArchiveBytes = 64L * 1024 * 1024;
    private const int MaximumItems = 10_000;
    private const int MaximumManagedImports = 200;

    internal static IEndpointRouteBuilder MapTemplateImportEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var imports = endpoints.MapGroup("/api/v1/template-imports").WithTags("Template imports");
        imports.MapPost("/", BeginUser)
            .WithName("BeginTemplateImport")
            .Produces<TemplateImportUploadResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapGet("/{importId:guid}", Get)
            .WithName("GetTemplateImport")
            .Produces<TemplateImportResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        imports.MapPost("/{importId:guid}/preview", QueuePreview)
            .WithName("PreviewTemplateImport")
            .Produces<OperationResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapPost("/{importId:guid}/commit", QueueCommit)
            .WithName("CommitTemplateImport")
            .Produces<OperationResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        imports.MapDelete("/{importId:guid}", Cancel)
            .WithName("CancelTemplateImport")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var managed = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}")
            .ExcludeFromDescription()
            .WithTags("Managed template imports");
        managed.MapPost("/managed-template-imports", BeginManaged)
            .WithRequestBodyLimit(16 * 1024)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        managed.MapPost("/managed-templates/finalize", FinalizeManaged)
            .WithRequestBodyLimit(2 * 1024 * 1024)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        managed.MapPost("/managed-template-stages/sweep", SweepManagedStages)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var imports = group.MapGroup("/template-imports/{importId:guid}");
        imports.MapGet("/preview", GetPreviewExecution);
        imports.MapPost("/preview/complete", CompletePreviewExecution);
        imports.MapGet("/commit", GetCommitExecution);
        imports.MapPost("/stage", StageExecution).WithRequestBodyLimit(16L * 1024 * 1024);
        imports.MapGet("/bodies/authorization", AuthorizeBodiesExecution);
        imports.MapPost("/complete", CompleteExecution);
        imports.MapPost("/reject", RejectExecution);
    }

    private static Task<IResult> BeginUser(
        BeginTemplateArchiveImportRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IDocumentImportStore imports,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer) =>
        Begin(
            request.WorkspaceId,
            request.FileName,
            request.MediaType,
            request.ByteLength,
            request.IdempotencyKey,
            DocumentImportPurposes.TemplateUser,
            managedSource: null,
            context,
            files,
            imports,
            dispatcher,
            signer);

    private static Task<IResult> BeginManaged(
        Guid workspaceId,
        BeginManagedTemplateArchiveImportRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IDocumentImportStore imports,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer) =>
        Begin(
            workspaceId,
            request.FileName,
            request.MediaType,
            request.ByteLength,
            request.IdempotencyKey,
            DocumentImportPurposes.TemplateManaged,
            request.ManagedSource,
            context,
            files,
            imports,
            dispatcher,
            signer);

    private static async Task<IResult> Begin(
        Guid workspaceIdValue,
        string fileName,
        string mediaType,
        long byteLength,
        string idempotencyKey,
        string purpose,
        string? managedSource,
        HttpContext context,
        IFileStore files,
        IDocumentImportStore imports,
        NixDispatcher dispatcher,
        S3CapabilitySigner signer)
    {
        if (!ValidName(fileName)
            || !ValidMediaType(mediaType)
            || byteLength is <= 0 or > MaximumArchiveBytes
            || string.IsNullOrWhiteSpace(idempotencyKey)
            || idempotencyKey.Length > 160
            || (purpose == DocumentImportPurposes.TemplateManaged
                && (string.IsNullOrWhiteSpace(managedSource) || managedSource.Length > 500)))
        {
            return TypedResults.Problem(Invalid(context, "templates.import_invalid", "The template archive metadata is invalid."));
        }
        var workspaceId = WorkspaceId.From(workspaceIdValue);
        var authorization = await dispatcher.QueryAsync<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>(
            new AuthorizeTemplateImport(workspaceId),
            context.RequestAborted).ConfigureAwait(false);
        var managed = purpose == DocumentImportPurposes.TemplateManaged;
        if (authorization.IsFailure
            || (managed ? !authorization.Value.CanManageTemplates : !authorization.Value.CanWrite))
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (!signer.IsConfigured)
        {
            return StorageUnavailable(context);
        }
        var upload = await files.BeginAsync(
            new BeginFileUpload(
                workspaceId,
                null,
                null,
                fileName,
                mediaType,
                byteLength,
                idempotencyKey,
                FileUploadPurposes.TemplateImport),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.import_idempotency_conflict",
                "The idempotency key already belongs to a different upload."));
        }
        var operation = await imports.BeginAsync(
            new BeginDocumentImport(
                workspaceId,
                null,
                FileUploadId.From(upload.Id),
                "nix",
                fileName,
                idempotencyKey,
                purpose,
                managedSource),
            context.RequestAborted).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.import_idempotency_conflict",
                "The idempotency key already belongs to a different template import."));
        }
        var capability = operation.Status == DocumentImportStatuses.PendingUpload
            ? signer.PutSized(upload.ObjectKey, byteLength)
            : null;
        return TypedResults.Ok(new TemplateImportUploadResponse(
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
        return operation is null || !DocumentImportPurposes.IsTemplate(operation.Purpose)
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
        var operation = await TemplateImport(importId, context, imports).ConfigureAwait(false);
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
            return TypedResults.Problem(Conflict(
                context,
                "templates.preview_not_available",
                "This template import cannot start another preview."));
        }
        var scoped = Session(session);
        var payload = JsonSerializer.Serialize(
            new TemplateImportJobPayload(importId),
            TemplateImportsJsonContext.Default.TemplateImportJobPayload);
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(operation.WorkspaceId),
            "template.preview",
            $"template.preview:{importId:D}",
            payload,
            context.RequestAborted).ConfigureAwait(false);
        if (await imports.AttachPreviewJobAsync(
            DocumentImportId.From(importId),
            WorkerJobId.From(job.Id),
            context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.preview_not_available",
                "This template import cannot start another preview."));
        }
        return TypedResults.Accepted(
            $"/api/v1/operations/{job.Id:D}",
            OperationMapping.ToResponse(job));
    }

    private static async Task<IResult> QueueCommit(
        Guid importId,
        CommitTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var operation = await TemplateImport(importId, context, imports).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (operation.CommitJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PreviewReady
            || operation.SourceSha256 is null
            || !DigestEquals(operation.SourceSha256, request.ExpectedDigest))
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.commit_not_available",
                "A matching successful preview is required before commit."));
        }
        var scoped = Session(session);
        var payload = JsonSerializer.Serialize(
            new TemplateImportJobPayload(importId),
            TemplateImportsJsonContext.Default.TemplateImportJobPayload);
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(operation.WorkspaceId),
            "template.commit",
            $"template.commit:{importId:D}",
            payload,
            context.RequestAborted).ConfigureAwait(false);
        if (await imports.AttachCommitJobAsync(
            DocumentImportId.From(importId),
            WorkerJobId.From(job.Id),
            context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.commit_not_available",
                "This template import cannot start another commit."));
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
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        var operation = await TemplateImport(importId, context, imports).ConfigureAwait(false);
        if (operation is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (operation.TemplateOperationId is { } templateOperationId)
        {
            var aborted = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
                new AbortTemplateOperation(TemplateOperationId.From(templateOperationId)),
                context.RequestAborted).ConfigureAwait(false);
            if (aborted.IsFailure)
            {
                return TemplateProblem(context, aborted.Error);
            }
        }
        var scoped = Session(session);
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
        await QueueCleanup(cleanup, importId, context, jobs, scoped, signer.GetCleanupNotBefore()).ConfigureAwait(false);
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
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.preview").ConfigureAwait(false);
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
        return TypedResults.Ok(new WorkerTemplateImportPreviewResponse(
            execution.Import.Id,
            execution.Import.WorkspaceId,
            Origin(execution.Import.Purpose),
            execution.Import.ManagedSource,
            execution.Import.IdempotencyKey,
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
        CompleteTemplateImportPreviewRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (!ValidPreview(request)
            || await OwnedExecution(importId, context, imports, jobs, session, "template.preview").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var preview = new TemplateImportPreviewResponse(
            request.Profile,
            request.SourceSha256,
            request.RootItemType,
            request.ItemCount,
            request.BodyCount,
            request.ViewCount);
        var result = await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.PlanByteLength,
                request.SourceSha256,
                request.ItemCount,
                request.BodyCount,
                "[]",
                "[]",
                JsonSerializer.Serialize(preview, TemplateImportsJsonContext.Default.TemplateImportPreviewResponse)),
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
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || execution.Import.Status is not (DocumentImportStatuses.CommitQueued
                or DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed)
            || execution.Import.PlanSha256 is null
            || execution.Import.PlanByteLength is null
            || execution.Import.SourceSha256 is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (execution.Import.Status is DocumentImportStatuses.Staged or DocumentImportStatuses.Completed)
        {
            var completed = WorkerResult(execution.Import);
            return completed is null
                ? TypedResults.Problem(NotFound(context))
                : TypedResults.Ok(new WorkerTemplateImportCommitResponse(
                    execution.Import.Id,
                    execution.Import.WorkspaceId,
                    Origin(execution.Import.Purpose),
                    execution.Import.ManagedSource,
                    execution.Import.IdempotencyKey,
                    execution.SourceFileName,
                    execution.SourceMediaType,
                    execution.SourceByteLength,
                    execution.Import.PlanSha256,
                    execution.Import.PlanByteLength.Value,
                    execution.Import.SourceSha256,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    completed));
        }
        if (!signer.IsConfigured)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var plan = signer.Get(execution.Import.PlanObjectKey);
        var planUpload = signer.Put(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerTemplateImportCommitResponse(
            execution.Import.Id,
            execution.Import.WorkspaceId,
            Origin(execution.Import.Purpose),
            execution.Import.ManagedSource,
            execution.Import.IdempotencyKey,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            execution.Import.PlanSha256,
            execution.Import.PlanByteLength.Value,
            execution.Import.SourceSha256,
            source.Url,
            sourceDelete.Url,
            plan.Url,
            planUpload.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, plan, planUpload, planDelete),
            null));
    }

    private static async Task<IResult> StageExecution(
        Guid importId,
        StageTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher)
    {
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || !TryBuildTemplateImport(execution.Import, request, out var descriptor, out var items))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var staged = await dispatcher.SendAsync<BeginTemplateImport, TemplateImportPlan>(
            new BeginTemplateImport(
                WorkspaceId.From(execution.Import.WorkspaceId),
                execution.Import.IdempotencyKey,
                descriptor,
                items),
            context.RequestAborted).ConfigureAwait(false);
        if (staged.IsFailure)
        {
            return TemplateProblem(context, staged.Error);
        }
        var plan = staged.Value;
        var attached = await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(importId),
                plan.OperationId,
                plan.TemplateId,
                descriptor.StableKey,
                descriptor.Digest,
                plan.Unchanged),
            context.RequestAborted).ConfigureAwait(false);
        if (attached is null)
        {
            return TypedResults.Problem(ExecutionLost(context));
        }
        if (!await ExecutionStillLive(context, dispatch).ConfigureAwait(false))
        {
            return TypedResults.Problem(ExecutionLost(context));
        }
        return TypedResults.Ok(new TemplateImportStageResponse(
            importId,
            plan.OperationId?.Value,
            plan.TemplateId.Value,
            descriptor.StableKey,
            descriptor.Digest,
            plan.Unchanged,
            plan.ItemMappings.Select(Map).ToArray(),
            plan.BodyWrites.Select(Map).ToArray()));
    }

    private static async Task<IResult> AuthorizeBodiesExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] NixDispatcher dispatcher)
    {
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        var scoped = session.Current;
        if (execution is null
            || scoped is null
            || scoped.Value.WorkspaceId is null
            || execution.Import.Status is not (DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed))
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (execution.Import.TemplateOperationId is null)
        {
            if (execution.Import.TemplateUnchanged != true)
            {
                return TypedResults.Problem(NotFound(context));
            }
            return TypedResults.Ok(new TemplateImportBodyAuthorizationResponse(
                scoped.Value.TenantId.Value,
                scoped.Value.PrincipalId.Value,
                scoped.Value.WorkspaceId.Value.Value,
                importId,
                null,
                [],
                CanWrite: true));
        }
        var authorization = await dispatcher.QueryAsync<AuthorizeTemplateOperationWrites, Result<TemplateOperationWriteAuthorization>>(
            new AuthorizeTemplateOperationWrites(TemplateOperationId.From(execution.Import.TemplateOperationId.Value)),
            context.RequestAborted).ConfigureAwait(false);
        if (authorization.IsFailure)
        {
            return TemplateProblem(context, authorization.Error);
        }
        var value = authorization.Value;
        if (value.WorkspaceId.Value != execution.Import.WorkspaceId || !value.CanWrite)
        {
            return TypedResults.Problem(NotFound(context));
        }
        return TypedResults.Ok(new TemplateImportBodyAuthorizationResponse(
            value.TenantId.Value,
            value.PrincipalId.Value,
            value.WorkspaceId.Value,
            importId,
            value.OperationId.Value,
            value.BodyWrites.Select(write => new TemplateImportBodyAuthorizationItemResponse(
                write.SourceId,
                write.TargetItemId.Value,
                write.ItemType,
                write.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    private static async Task<IResult> CompleteExecution(
        Guid importId,
        CompleteTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        if (request.WrittenTargetItemIds is null
            || request.WrittenTargetItemIds.Count > MaximumItems
            || request.WrittenTargetItemIds.Distinct().Count() != request.WrittenTargetItemIds.Count)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || execution.Import.Status is not (DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var managed = execution.Import.Purpose == DocumentImportPurposes.TemplateManaged;
        if (execution.Import.Status == DocumentImportStatuses.Staging && !managed)
        {
            if (execution.Import.TemplateOperationId is { } operationId)
            {
                var finalized = await dispatcher.SendAsync<FinalizeTemplateOperation, TemplateId>(
                    new FinalizeTemplateOperation(
                        TemplateOperationId.From(operationId),
                        request.WrittenTargetItemIds.Select(ItemId.From).ToArray()),
                    context.RequestAborted).ConfigureAwait(false);
                if (finalized.IsFailure)
                {
                    return TemplateProblem(context, finalized.Error);
                }
            }
            else if (request.WrittenTargetItemIds.Count != 0 || execution.Import.TemplateUnchanged != true)
            {
                return TypedResults.Problem(NotFound(context));
            }
        }
        var result = await imports.CompleteTemplateAsync(
            new CompleteTemplateImport(
                DocumentImportId.From(importId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray(),
                managed),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (execution.Import.Status is not (DocumentImportStatuses.Staged or DocumentImportStatuses.Completed))
        {
            var scoped = Session(session);
            await ObjectCleanupJobs.QueueAsync(
                jobs,
                scoped.TenantId,
                scoped.PrincipalId,
                WorkspaceId.From(result.WorkspaceId),
                "template-import",
                importId,
                signer.GetCleanupNotBefore(),
                [execution.SourceObjectKey, execution.Import.PlanObjectKey],
                context.RequestAborted).ConfigureAwait(false);
        }
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(WorkerResult(result)
                ?? throw new InvalidOperationException("A completed template import must retain its durable result."))
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> RejectExecution(
        Guid importId,
        RejectTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            expectedKind: null).ConfigureAwait(false);
        if (execution is null || !ValidFailureCode(request.Code))
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (execution.Import.TemplateOperationId is { } operationId)
        {
            var aborted = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
                new AbortTemplateOperation(TemplateOperationId.From(operationId)),
                context.RequestAborted).ConfigureAwait(false);
            if (aborted.IsFailure)
            {
                return TemplateProblem(context, aborted.Error);
            }
        }
        var cleanup = await imports.FailAsync(
            DocumentImportId.From(importId),
            request.Code,
            context.RequestAborted).ConfigureAwait(false);
        if (cleanup is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = Session(session);
        await QueueCleanup(cleanup, importId, context, jobs, scoped, signer.GetCleanupNotBefore()).ConfigureAwait(false);
        return await ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> FinalizeManaged(
        Guid workspaceId,
        ManagedTemplateImportFinalizationRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore attempts,
        [FromServices] NixDispatcher dispatcher)
    {
        if (request.Imports is null
            || request.ActiveStableKeys is null
            || request.Imports.Any(value => value is null || value.WrittenTargetItemIds is null)
            || request.Imports.Count > MaximumManagedImports
            || request.ActiveStableKeys.Count > MaximumManagedImports
            || request.Imports.Select(value => value.ImportId).Distinct().Count() != request.Imports.Count)
        {
            return TypedResults.Problem(Invalid(context, "templates.managed_batch_invalid", "The managed template batch is invalid."));
        }
        if (!await CanManageTemplatesAsync(workspaceId, context, dispatcher).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var imports = new ManagedTemplateFinalization[request.Imports.Count];
        var ids = new DocumentImportId[request.Imports.Count];
        for (var index = 0; index < request.Imports.Count; index++)
        {
            var requested = request.Imports[index]!;
            var attempt = await attempts.GetAsync(
                DocumentImportId.From(requested.ImportId),
                context.RequestAborted).ConfigureAwait(false);
            if (attempt is null
                || attempt.WorkspaceId != workspaceId
                || attempt.Purpose != DocumentImportPurposes.TemplateManaged
                || attempt.Status is not (DocumentImportStatuses.Staged or DocumentImportStatuses.Completed)
                || attempt.TemplateOperationId != requested.OperationId
                || attempt.TemplateId != requested.TemplateId
                || !string.Equals(attempt.TemplateStableKey, requested.StableKey, StringComparison.Ordinal)
                || !string.Equals(attempt.TemplateDigest, requested.Digest, StringComparison.Ordinal)
                || !StoredIdsEqual(attempt.TemplateWrittenTargetItemIds, requested.WrittenTargetItemIds))
            {
                return TypedResults.Problem(NotFound(context));
            }
            ids[index] = DocumentImportId.From(requested.ImportId);
            imports[index] = new ManagedTemplateFinalization(
                requested.OperationId is { } operationId ? TemplateOperationId.From(operationId) : null,
                TemplateId.From(requested.TemplateId),
                requested.StableKey,
                requested.Digest,
                requested.WrittenTargetItemIds.Select(ItemId.From).ToArray());
        }
        var finalized = await dispatcher.SendAsync<FinalizeManagedTemplates, ManagedTemplateBatchResult>(
            new FinalizeManagedTemplates(
                WorkspaceId.From(workspaceId),
                imports,
                request.ActiveStableKeys),
            context.RequestAborted).ConfigureAwait(false);
        if (finalized.IsFailure)
        {
            return TemplateProblem(context, finalized.Error);
        }
        if (!await attempts.CompleteManagedBatchAsync(ids, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(Conflict(
                context,
                "templates.managed_batch_conflict",
                "The managed template batch changed before publication."));
        }
        return TypedResults.Ok(new ManagedTemplateImportFinalizationResponse(
            finalized.Value.Activated,
            finalized.Value.Unchanged,
            finalized.Value.Retired));
    }

    private static async Task<IResult> SweepManagedStages(
        Guid workspaceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!await CanManageTemplatesAsync(workspaceId, context, dispatcher).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var swept = await dispatcher.SendAsync<SweepExpiredTemplateStages, TemplateStageSweepResult>(
            new SweepExpiredTemplateStages(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return swept.IsFailure
            ? TemplateProblem(context, swept.Error)
            : TypedResults.Ok(new ManagedTemplateStageSweepResponse(
                swept.Value.Removed,
                swept.Value.ItemIds.Select(value => value.Value).ToArray()));
    }

    private static async Task<bool> CanManageTemplatesAsync(
        Guid workspaceId,
        HttpContext context,
        NixDispatcher dispatcher)
    {
        var authorization = await dispatcher.QueryAsync<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>(
            new AuthorizeTemplateImport(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return authorization.IsSuccess && authorization.Value.CanManageTemplates;
    }

    private static async Task<DocumentImportRecord?> TemplateImport(
        Guid importId,
        HttpContext context,
        IDocumentImportStore imports)
    {
        var operation = await imports.GetAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        return operation is not null && DocumentImportPurposes.IsTemplate(operation.Purpose)
            ? operation
            : null;
    }

    private static async Task<DocumentImportExecutionRecord?> OwnedExecution(
        Guid importId,
        HttpContext context,
        IDocumentImportStore imports,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        string? expectedKind)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return null;
        }
        var scoped = Session(session);
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is null
            || job.Status != "running"
            || (expectedKind is null
                ? job.Kind is not ("template.preview" or "template.commit")
                : job.Kind != expectedKind))
        {
            return null;
        }
        TemplateImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                TemplateImportsJsonContext.Default.TemplateImportJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }
        var execution = payload?.ImportId == importId
            ? await imports.GetExecutionAsync(DocumentImportId.From(importId), context.RequestAborted).ConfigureAwait(false)
            : null;
        if (execution is null
            || !DocumentImportPurposes.IsTemplate(execution.Import.Purpose)
            || (job.Kind == "template.commit"
                ? execution.Import.CommitJobId != jobId
                : execution.Import.PreviewJobId != jobId))
        {
            return null;
        }
        return execution;
    }

    private static bool TryBuildTemplateImport(
        DocumentImportRecord operation,
        StageTemplateImportRequest request,
        out TemplateImportDescriptor descriptor,
        out IReadOnlyList<TemplateImportItem> items)
    {
        descriptor = null!;
        items = [];
        var preview = ParsePreview(operation.TemplatePreview);
        if (request.Profile is null
            || request.Items is null
            || preview is null
            || operation.SourceSha256 is null
            || request.Profile != preview.Profile
            || request.Items.Count != preview.ItemCount
            || request.Items.Count is < 1 or > MaximumItems
            || request.Items.Count(value => value.HasBody) != preview.BodyCount
            || request.Items.Count(value => value.ParentSourceId is null) != 1
            || (!request.Profile.IncludeChildren && request.Items.Count != 1)
            || request.Items.Single(value => value.ParentSourceId is null).ItemType != preview.RootItemType
            || request.Items.Any(value => !ValidOptionalObject(value.Properties)
                || !ValidOptionalObject(value.Schema)
                || !ValidOptionalObject(value.Views)))
        {
            return false;
        }
        var built = new TemplateImportItem[request.Items.Count];
        for (var index = 0; index < request.Items.Count; index++)
        {
            var item = request.Items[index];
            if (!TemplateSequence.TryParse(item.Seq, out var sequence))
            {
                return false;
            }
            built[index] = new TemplateImportItem(
                item.SourceId,
                item.ParentSourceId,
                item.ItemType,
                item.Title,
                sequence,
                Json(item.Properties),
                Json(item.Schema),
                Json(item.Views),
                item.HasBody);
        }
        descriptor = new TemplateImportDescriptor(
            request.Profile.Key,
            request.Profile.Name,
            request.Profile.Description,
            operation.Purpose == DocumentImportPurposes.TemplateManaged ? TemplateOrigin.Managed : TemplateOrigin.User,
            operation.ManagedSource,
            operation.SourceSha256,
            request.Profile.IncludeBody,
            request.Profile.IncludeChildren);
        items = built;
        return true;
    }

    private static TemplateImportResponse ToResponse(DocumentImportRecord value) => new(
        value.Id,
        value.WorkspaceId,
        value.Status,
        value.PreviewJobId,
        value.CommitJobId,
        ParsePreview(value.TemplatePreview),
        value.TemplateId is null
            || value.TemplateStableKey is null
            || value.TemplateDigest is null
            || value.TemplateUnchanged is null
                ? null
                : new TemplateImportResultResponse(
                    value.TemplateOperationId,
                    value.TemplateId.Value,
                    value.TemplateStableKey,
                    value.TemplateDigest,
                    value.TemplateUnchanged.Value,
                    ParseIds(value.TemplateWrittenTargetItemIds)),
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    private static WorkerCompleteTemplateImportResponse? WorkerResult(DocumentImportRecord value)
    {
        var preview = ParsePreview(value.TemplatePreview);
        return preview is null
            || value.TemplateId is null
            || value.TemplateStableKey is null
            || value.TemplateDigest is null
            || value.TemplateUnchanged is null
                ? null
                : new WorkerCompleteTemplateImportResponse(
                    value.Id,
                    value.TemplateOperationId,
                    value.TemplateId.Value,
                    value.TemplateStableKey,
                    value.TemplateDigest,
                    value.TemplateUnchanged.Value,
                    preview.ItemCount,
                    preview.BodyCount,
                    ParseIds(value.TemplateWrittenTargetItemIds));
    }

    private static TemplateImportPreviewResponse? ParsePreview(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }
        return JsonSerializer.Deserialize(
            json,
            TemplateImportsJsonContext.Default.TemplateImportPreviewResponse)
            ?? throw new InvalidOperationException("A durable template preview cannot be null.");
    }

    private static Guid[] ParseIds(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 2 });
        return document.RootElement.EnumerateArray().Select(value => value.GetGuid()).ToArray();
    }

    private static bool StoredIdsEqual(string? stored, IReadOnlyList<Guid> requested) =>
        ParseIds(stored).Order().SequenceEqual(requested.Distinct().Order());

    private static TemplateImportItemMappingResponse Map(TemplateItemMapping value) =>
        new(value.SourceId, value.ItemId.Value, value.ItemType);

    private static TemplateImportItemMappingResponse Map(TemplateBodyWrite value) =>
        new(value.SourceId, value.TargetItemId.Value, value.ItemType);

    private static string? Json(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Object } ? value.Value.GetRawText() : null;

    private static bool ValidOptionalObject(JsonElement? value) =>
        value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Object;

    private static bool ValidPreview(CompleteTemplateImportPreviewRequest value) =>
        ValidDigest(value.PlanSha256)
        && ValidDigest(value.SourceSha256)
        && value.PlanByteLength is > 0 and <= MaximumArchiveBytes
        && ValidProfile(value.Profile)
        && !string.IsNullOrWhiteSpace(value.RootItemType)
        && value.RootItemType.Length <= 64
        && value.ItemCount is > 0 and <= MaximumItems
        && value.BodyCount >= 0
        && value.BodyCount <= value.ItemCount
        && value.ViewCount is >= 0 and <= MaximumItems;

    private static bool ValidProfile(TemplateImportProfileResponse? value) =>
        value is not null
        && value.Kind == "template"
        && value.Version == 1
        && !string.IsNullOrWhiteSpace(value.Key)
        && value.Key.Length <= 160
        && !string.IsNullOrWhiteSpace(value.Name)
        && value.Name.Length <= 200
        && value.Description is not null
        && value.Description.Length <= 1_000;

    private static bool DigestEquals(string? expected, string? actual)
    {
        if (!ValidDigest(expected) || !ValidDigest(actual))
        {
            return false;
        }
        Span<byte> expectedBytes = stackalloc byte[64];
        Span<byte> actualBytes = stackalloc byte[64];
        Encoding.ASCII.GetBytes(expected, expectedBytes);
        Encoding.ASCII.GetBytes(actual, actualBytes);
        return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private static bool ValidDigest(string? value) =>
        value is not null
        && value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ValidFailureCode(string? code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 80
        && code.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_');

    private static bool ValidName(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 255
        && value.IndexOfAny(['/', '\\', '\0']) < 0;

    private static bool ValidMediaType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        return separator > 0
            && separator < value.Length - 1
            && value.Length <= 160
            && value.All(character => character is >= (char)0x21 and <= (char)0x7e && character is not ';' and not '\\');
    }

    private static string Origin(string purpose) => purpose switch
    {
        DocumentImportPurposes.TemplateUser => "user",
        DocumentImportPurposes.TemplateManaged => "managed",
        _ => throw new InvalidOperationException("A non-template purpose reached the template import boundary."),
    };

    private static NixSessionContext Session(INixSessionContextAccessor session) =>
        session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    private static async Task<IResult> ExistingOperation(
        Guid jobId,
        HttpContext context,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session)
    {
        var scoped = Session(session);
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        return job is null
            ? TypedResults.Problem(NotFound(context))
            : TypedResults.Accepted($"/api/v1/operations/{job.Id:D}", OperationMapping.ToResponse(job));
    }

    private static async Task QueueCleanup(
        DocumentImportCleanupRecord cleanup,
        Guid importId,
        HttpContext context,
        IWorkerJobStore jobs,
        NixSessionContext scoped,
        DateTimeOffset notBefore) =>
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "template-import",
            importId,
            notBefore,
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);

    private static async Task<bool> ExecutionStillLive(HttpContext context, IWorkerDispatchStore dispatch)
    {
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        return Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId)
            && await dispatch.AuthorizeExecutionAsync(jobId, executionId, context.RequestAborted).ConfigureAwait(false) is not null;
    }

    private static DateTimeOffset MinimumExpiry(params ObjectCapability[] capabilities) =>
        capabilities.Min(value => value.ExpiresAt);

    private static ProblemHttpResult TemplateProblem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            "templates.not_found" => StatusCodes.Status404NotFound,
            "templates.forbidden" => StatusCodes.Status403Forbidden,
            "templates.invalid" => StatusCodes.Status422UnprocessableEntity,
            _ => StatusCodes.Status409Conflict,
        };
        return TypedResults.Problem(ApiProblem.Create(
            context,
            status,
            error.Code,
            "Template import refused",
            error.Message));
    }

    private static Microsoft.AspNetCore.Mvc.ProblemDetails NotFound(HttpContext context) =>
        ApiProblem.Create(context, 404, "templates.import_not_found", "Template import not found", "No such template import is visible.");

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Invalid(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 400, code, "Template import refused", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Conflict(HttpContext context, string code, string detail) =>
        ApiProblem.Create(context, 409, code, "Template import conflict", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails ExecutionLost(HttpContext context) =>
        ApiProblem.Create(context, 409, "worker.execution_refused", "Worker execution refused", "The worker no longer owns a live execution for this job.");

    private static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            503,
            "templates.storage_not_configured",
            "Template import storage unavailable",
            "Private object storage is not configured for this deployment."));
}
