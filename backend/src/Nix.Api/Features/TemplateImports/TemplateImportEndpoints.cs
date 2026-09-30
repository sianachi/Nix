using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Features.Operations;
using Nix.Features.Templates;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.TemplateImports;

/// <summary>Durable user and managed template archive orchestration for the signed-in principal: upload, preview, commit, cancel and managed batches.</summary>
internal static class TemplateImportEndpoints
{
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
        if (!TemplateImportRules.ValidName(fileName)
            || !TemplateImportRules.ValidMediaType(mediaType)
            || byteLength is <= 0 or > TemplateImportRules.MaximumArchiveBytes
            || string.IsNullOrWhiteSpace(idempotencyKey)
            || idempotencyKey.Length > 160
            || (purpose == DocumentImportPurposes.TemplateManaged
                && (string.IsNullOrWhiteSpace(managedSource) || managedSource.Length > 500)))
        {
            return TypedResults.Problem(TemplateImportProblems.Invalid(context, "templates.import_invalid", "The template archive metadata is invalid."));
        }
        var workspaceId = WorkspaceId.From(workspaceIdValue);
        var authorization = await dispatcher.QueryAsync<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>(
            new AuthorizeTemplateImport(workspaceId),
            context.RequestAborted).ConfigureAwait(false);
        var managed = purpose == DocumentImportPurposes.TemplateManaged;
        if (authorization.IsFailure
            || (managed ? !authorization.Value.CanManageTemplates : !authorization.Value.CanWrite))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (!signer.IsConfigured)
        {
            return TemplateImportProblems.StorageUnavailable(context);
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
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            ? TypedResults.Problem(TemplateImportProblems.NotFound(context))
            : TypedResults.Ok(TemplateImportMapping.ToResponse(operation));
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
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (operation.PreviewJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PendingUpload)
        {
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (operation.CommitJobId is { } existingId)
        {
            return await ExistingOperation(existingId, context, jobs, session).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.PreviewReady
            || operation.SourceSha256 is null
            || !TemplateImportRules.DigestEquals(operation.SourceSha256, request.ExpectedDigest))
        {
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (operation.TemplateOperationId is { } templateOperationId)
        {
            var aborted = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
                new AbortTemplateOperation(TemplateOperationId.From(templateOperationId)),
                context.RequestAborted).ConfigureAwait(false);
            if (aborted.IsFailure)
            {
                return TemplateImportProblems.TemplateProblem(context, aborted.Error);
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
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        await TemplateImportCleanup.QueueAsync(cleanup, importId, context, jobs, scoped, signer.GetCleanupNotBefore()).ConfigureAwait(false);
        return TypedResults.NoContent();
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
            || request.Imports.Count > TemplateImportRules.MaximumManagedImports
            || request.ActiveStableKeys.Count > TemplateImportRules.MaximumManagedImports
            || request.Imports.Select(value => value.ImportId).Distinct().Count() != request.Imports.Count)
        {
            return TypedResults.Problem(TemplateImportProblems.Invalid(context, "templates.managed_batch_invalid", "The managed template batch is invalid."));
        }
        if (!await CanManageTemplatesAsync(workspaceId, context, dispatcher).ConfigureAwait(false))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
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
                || !TemplateImportMapping.StoredIdsEqual(attempt.TemplateWrittenTargetItemIds, requested.WrittenTargetItemIds))
            {
                return TypedResults.Problem(TemplateImportProblems.NotFound(context));
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
            return TemplateImportProblems.TemplateProblem(context, finalized.Error);
        }
        if (!await attempts.CompleteManagedBatchAsync(ids, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(TemplateImportProblems.Conflict(
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
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var swept = await dispatcher.SendAsync<SweepExpiredTemplateStages, TemplateStageSweepResult>(
            new SweepExpiredTemplateStages(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return swept.IsFailure
            ? TemplateImportProblems.TemplateProblem(context, swept.Error)
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
            ? TypedResults.Problem(TemplateImportProblems.NotFound(context))
            : TypedResults.Accepted($"/api/v1/operations/{job.Id:D}", OperationMapping.ToResponse(job));
    }

}
