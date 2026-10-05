using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Templates;

/// <summary>Service-authenticated /internal template orchestration: capture, import, application, export and drafts.</summary>
internal static class TemplateInternalEndpoints
{
    internal static void MapInternalTemplateEndpoints(IEndpointRouteBuilder endpoints)
    {
        var internalTemplates = endpoints.MapGroup("/internal/templates")
            .ExcludeFromDescription()
            .WithTags("Internal templates");
        var internalTemplateWrites = endpoints.MapGroup("/internal/templates")
            .ExcludeFromDescription()
            .WithTags("Internal templates");
        internalTemplateWrites.MapPost("/captures/begin", BeginCapture)
            .Produces<BeginTemplateCaptureResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplateWrites.MapPost("/imports/begin", BeginImport)
            .WithRequestBodyLimit(16 * 1024 * 1024)
            .Produces<BeginTemplateImportResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplateWrites.MapPost("/applications/begin", BeginApplication)
            .Produces<BeginTemplateApplicationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplateWrites.MapPost("/captures/{operationId:guid}/finalize", FinalizeOperation)
            .Produces<FinalizeTemplateResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapPost("/imports/{operationId:guid}/finalize", FinalizeOperation)
            .Produces<FinalizeTemplateResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapPost("/applications/{applicationId:guid}/finalize", FinalizeApplication)
            .Produces<FinalizeTemplateApplicationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapDelete("/captures/{operationId:guid}", AbortOperation)
            .Produces(StatusCodes.Status204NoContent);
        internalTemplateWrites.MapDelete("/imports/{operationId:guid}", AbortOperation)
            .Produces(StatusCodes.Status204NoContent);
        internalTemplateWrites.MapDelete("/applications/{operationId:guid}", AbortApplication)
            .Produces(StatusCodes.Status204NoContent);
        internalTemplates.MapGet("/{templateId:guid}/items/{sourceId:guid}/authorization", TemplateItemAuthorization)
            .Produces<TemplateItemAuthorizationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        internalTemplates.MapGet("/{templateId:guid}/export", Export)
            .Produces<TemplateExportResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        internalTemplates.MapGet("/{templateId:guid}/export/files", ExportFiles)
            .Produces<TemplateExportFilesPageResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        internalTemplates.MapGet("/{templateId:guid}/export/files/{fileVersionId:guid}/capability", ExportFileCapability)
            .Produces<TemplateExportFileCapabilityResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        internalTemplateWrites.MapPost("/{templateId:guid}/drafts", BeginDraft)
            .Produces<TemplateDraftResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplates.MapGet("/{templateId:guid}/drafts/{operationId:guid}", GetDraft)
            .Produces<TemplateDraftResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapPatch("/{templateId:guid}/drafts/{operationId:guid}", UpdateDraft)
            .Produces<TemplateDraftResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplateWrites.MapPatch(
                "/{templateId:guid}/drafts/{operationId:guid}/items/{sourceId:guid}",
                UpdateDraftItem)
            .Produces<TemplateItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        internalTemplates.MapGet(
                "/{templateId:guid}/drafts/{operationId:guid}/items/{sourceId:guid}/authorization",
                DraftItemAuthorization)
            .Produces<TemplateItemAuthorizationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapPost("/{templateId:guid}/drafts/{operationId:guid}/save", SaveDraft)
            .Produces<FinalizeTemplateResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        internalTemplateWrites.MapDelete("/{templateId:guid}/drafts/{operationId:guid}", DiscardDraft)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        endpoints.MapGet(
                "/internal/template-operations/{operationId:guid}/items/{itemId:guid}/authorization",
                OperationItemAuthorization)
            .WithTags("Internal templates")
            .ExcludeFromDescription()
            .Produces<TemplateOperationAuthorizationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        endpoints.MapPost(
                "/internal/workspaces/{workspaceId:guid}/templates/managed/finalize",
                FinalizeManagedTemplates)
            .WithTags("Internal templates")
            .ExcludeFromDescription()
            .Produces<FinalizeManagedTemplatesResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        endpoints.MapPost(
                "/internal/workspaces/{workspaceId:guid}/template-stages/expired/sweep",
                SweepExpiredStages)
            .WithTags("Internal templates")
            .ExcludeFromDescription()
            .Produces<SweepExpiredTemplateStagesResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        endpoints.MapGet(
                "/internal/workspaces/{workspaceId:guid}/templates/import-authorization",
                ImportAuthorization)
            .WithTags("Internal templates")
            .ExcludeFromDescription()
            .Produces<TemplateImportAuthorizationResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
    }

    private static async Task<IResult> BeginCapture(
        BeginTemplateCaptureRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var result = await dispatcher.SendAsync<BeginTemplateCapture, TemplateCapturePlan>(
            new BeginTemplateCapture(
                WorkspaceId.From(request.WorkspaceId),
                ItemId.From(request.SourceItemId),
                request.Title,
                request.Description,
                request.IncludeBody,
                request.IncludeChildren,
                request.IdempotencyKey,
                request.ExpectedFingerprint),
            context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TemplateProblems.Refused(context, result.Error);
        }
        var plan = result.Value;
        TemplateFileTransferJobReceipt fileJob;
        try
        {
            fileJob = await TemplateFileTransferJobs.EnsureAsync(
                "operation",
                plan.OperationId.Value,
                plan.ItemMappings.Any(mapping => mapping.ItemType == "file"),
                transfers,
                jobs,
                session,
                context.RequestAborted).ConfigureAwait(false);
        }
        catch (WorkerJobIdempotencyConflictException)
        {
            return TemplateProblems.Refused(context, TemplateErrors.Conflict("The template file-copy job conflicts with existing work."));
        }
        return TypedResults.Ok(new BeginTemplateCaptureResponse(
            plan.OperationId.Value,
            plan.TemplateId.Value,
            plan.ItemMappings.Select(Map).ToArray(),
            plan.BodyCopies.Select(Map).ToArray(),
            fileJob.JobId,
            fileJob.Pending));
    }

    private static async Task<IResult> BeginImport(
        BeginTemplateImportRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!TryOrigin(request.Template.Origin, out var origin))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid("Origin must be 'user' or 'managed'."));
        }

        if (!TryInitialization(request.Template.Initialization, out var initialization, out var initializationRefusal))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid(initializationRefusal!));
        }

        var descriptor = new TemplateImportDescriptor(
            request.Template.StableKey,
            request.Template.Title,
            request.Template.Description,
            origin,
            request.Template.ManagedSource,
            request.Template.Digest,
            request.Template.IncludeBody,
            request.Template.IncludeChildren,
            initialization);
        var items = new TemplateImportItem[request.Items.Count];
        for (var index = 0; index < request.Items.Count; index++)
        {
            var item = request.Items[index];
            if (!TemplateSequence.TryParse(item.Seq, out var sequence))
            {
                return TemplateProblems.Refused(
                    context,
                    TemplateErrors.Invalid(
                        $"Template item '{item.SourceId}' has a sequence outside the signed 64-bit integer range."));
            }

            items[index] = new TemplateImportItem(
                item.SourceId,
                item.ParentSourceId,
                item.ItemType,
                item.Title,
                sequence,
                item.Properties?.ToJsonString(),
                item.Schema?.ToJsonString(),
                item.Views?.ToJsonString(),
                item.HasBody,
                item.Recurrence?.ToJsonString());
        }
        var result = await dispatcher.SendAsync<BeginTemplateImport, TemplateImportPlan>(
            new BeginTemplateImport(
                WorkspaceId.From(request.WorkspaceId),
                request.IdempotencyKey,
                descriptor,
                items),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            plan => TypedResults.Ok(new BeginTemplateImportResponse(
                plan.OperationId?.Value,
                plan.TemplateId.Value,
                plan.Unchanged,
                plan.ItemMappings.Select(Map).ToArray(),
                plan.BodyWrites.Select(Map).ToArray())),
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> BeginApplication(
        BeginTemplateApplicationRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        if (!TryMode(request.Mode, out var mode))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid("Mode must be 'merge' or 'create'."));
        }

        var result = await dispatcher.SendAsync<BeginTemplateApplication, TemplateApplicationPlan>(
            new BeginTemplateApplication(
                TemplateId.From(request.TemplateId),
                mode,
                request.TargetItemId is { } target ? ItemId.From(target) : null,
                request.ParentItemId is { } parent ? ItemId.From(parent) : null,
                request.Title,
                request.IdempotencyKey,
                request.Inputs,
                request.ExpectedRevision),
            context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TemplateProblems.Refused(context, result.Error);
        }
        var plan = result.Value;
        TemplateFileTransferJobReceipt fileJob;
        try
        {
            fileJob = await TemplateFileTransferJobs.EnsureAsync(
                "application",
                plan.ApplicationId.Value,
                plan.ItemMappings.Any(mapping => mapping.ItemType == "file"),
                transfers,
                jobs,
                session,
                context.RequestAborted).ConfigureAwait(false);
        }
        catch (WorkerJobIdempotencyConflictException)
        {
            return TemplateProblems.Refused(context, TemplateErrors.Conflict("The template file-copy job conflicts with existing work."));
        }
        var mappings = plan.ItemMappings.Select(Map).ToArray();
        return TypedResults.Ok(new BeginTemplateApplicationResponse(
            plan.ApplicationId.Value,
            plan.TemplateId.Value,
            plan.TargetItemId.Value,
            plan.AlreadyApplied,
            plan.CreatedItems.Select(Map).ToArray(),
            mappings,
            plan.BodyCopies.Select(Map).ToArray(),
            TemplateMapping.ResolutionOrEmpty(plan.Resolution).TemplateRevision,
            TemplateMapping.ResolutionOrEmpty(plan.Resolution).Values,
            (plan.InitializationPreview ?? []).Select(TemplateMapping.Preview).ToArray(),
            TemplateMapping.ResolutionOrEmpty(plan.Resolution).TextBindings,
            TemplateMapping.ResolutionOrEmpty(plan.Resolution).ReferenceMappings,
            fileJob.JobId,
            fileJob.Pending));
    }

    private static async Task<IResult> FinalizeOperation(
        Guid operationId,
        FinalizeTemplateBodiesRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers)
    {
        if (await transfers.HasUnreadyCopiesAsync("operation", operationId, context.RequestAborted)
            .ConfigureAwait(false))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Conflict("File copies must complete before publishing this template stage."));
        }
        var result = await dispatcher.SendAsync<FinalizeTemplateOperation, TemplateId>(
            new FinalizeTemplateOperation(
                TemplateOperationId.From(operationId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray(),
                request.ExternalReferenceTargets),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            templateId => TypedResults.Ok(new FinalizeTemplateResponse(templateId.Value)),
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> FinalizeApplication(
        Guid applicationId,
        FinalizeTemplateBodiesRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers)
    {
        if (await transfers.HasUnreadyCopiesAsync("application", applicationId, context.RequestAborted)
            .ConfigureAwait(false))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Conflict("File copies must complete before publishing this application."));
        }
        var result = await dispatcher.SendAsync<FinalizeTemplateApplication, ItemId>(
            new FinalizeTemplateApplication(
                TemplateApplicationId.From(applicationId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray()),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            itemId => TypedResults.Ok(new FinalizeTemplateApplicationResponse(itemId.Value)),
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> AbortOperation(
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
            new AbortTemplateOperation(TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> AbortApplication(
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AbortTemplateApplication, bool>(
            new AbortTemplateApplication(TemplateApplicationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> OperationItemAuthorization(
        Guid operationId,
        Guid itemId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<AuthorizeTemplateOperationItem, Result<TemplateOperationAuthorization>>(
            new AuthorizeTemplateOperationItem(operationId, ItemId.From(itemId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(authorization => TypedResults.Ok(new TemplateOperationAuthorizationResponse(
            authorization.OperationId,
            authorization.ItemId.Value,
            authorization.TenantId.Value,
            authorization.PrincipalId.Value,
            authorization.WorkspaceId.Value,
            authorization.ItemType,
            authorization.IsSource,
            authorization.IsTarget,
            authorization.CanWrite)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> TemplateItemAuthorization(
        Guid templateId,
        Guid sourceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<AuthorizeTemplateItem, Result<TemplateItemAuthorization>>(
            new AuthorizeTemplateItem(TemplateId.From(templateId), sourceId),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(authorization => TypedResults.Ok(new TemplateItemAuthorizationResponse(
            authorization.TemplateId.Value,
            authorization.SourceId,
            authorization.ItemId.Value,
            authorization.TenantId.Value,
            authorization.PrincipalId.Value,
            authorization.WorkspaceId.Value,
            authorization.ItemType,
            authorization.CanRead,
            authorization.CanWrite)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> Export(
        Guid templateId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        var result = await dispatcher.QueryAsync<ExportTemplate, Result<TemplateExportSnapshot>>(
            new ExportTemplate(TemplateId.From(templateId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(snapshot =>
        {
            return TypedResults.Ok(new TemplateExportResponse(
            snapshot.TemplateId.Value,
            snapshot.WorkspaceId.Value,
            snapshot.StableKey,
            snapshot.Title,
            snapshot.Description,
            TemplateMapping.Origin(snapshot.Origin),
            snapshot.Revision,
            snapshot.IncludeBody,
            snapshot.IncludeChildren,
            snapshot.Initialization ?? TemplateInitialization.Empty,
            snapshot.Items.Select(item => new TemplateExportItemResponse(
                item.SourceId,
                item.ParentSourceId,
                item.ItemId.Value,
                item.ItemType,
                item.Title,
                item.Seq.ToString(CultureInfo.InvariantCulture),
                TemplateMapping.Object(item.Properties) ?? [],
                TemplateMapping.Object(item.Schema),
                TemplateMapping.Object(item.Views),
                item.HasBody,
                TemplateMapping.Object(item.Recurrence))).ToArray(),
            []));
        }, error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> ExportFiles(
        Guid templateId,
        Guid? afterFileVersionId,
        int? revision,
        int? limit,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var pageSize = limit ?? 100;
        if (pageSize is < 1 or > 100)
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid("The template export file page size is invalid."));
        }
        var result = await dispatcher.QueryAsync<ExportTemplateFiles, Result<TemplateExportFilesPage>>(
            new ExportTemplateFiles(TemplateId.From(templateId), revision, afterFileVersionId, pageSize),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(page => TypedResults.Ok(new TemplateExportFilesPageResponse(
            page.Revision,
            page.Files.Select(file => new TemplateExportFileResponse(
                file.FileVersionId, file.SourceId, file.Version, file.Current, file.FileName, file.MediaType,
                file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight, null, null)).ToArray(),
            page.NextAfterFileVersionId,
            page.Complete)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> ExportFileCapability(
        Guid templateId,
        Guid fileVersionId,
        int revision,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return TypedResults.Problem(new Microsoft.AspNetCore.Mvc.ProblemDetails
            {
                Status = StatusCodes.Status503ServiceUnavailable,
                Title = "File storage unavailable",
                Detail = "Template attachments cannot be exported while object storage is unavailable.",
            });
        }
        var file = await dispatcher.QueryAsync<AuthorizeTemplateExportFile, TemplateExportFileDownload?>(
            new AuthorizeTemplateExportFile(TemplateId.From(templateId), revision, fileVersionId),
            context.RequestAborted).ConfigureAwait(false);
        if (file is null)
        {
            return TemplateProblems.Refused(context, TemplateErrors.NotFound("No such template file version is visible."));
        }

        var capability = signer.Get(file.ObjectKey);
        return TypedResults.Ok(new TemplateExportFileCapabilityResponse(capability.Url, capability.ExpiresAt));
    }

    private static async Task<IResult> BeginDraft(
        Guid templateId,
        BeginTemplateDraftRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var result = await dispatcher.SendAsync<BeginTemplateDraft, TemplateDraftPlan>(
            new BeginTemplateDraft(TemplateId.From(templateId), request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TemplateProblems.Refused(context, result.Error);
        }
        return TypedResults.Ok(await MapWithFileTransferJobAsync(
            result.Value,
            transfers,
            jobs,
            session,
            context.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<IResult> GetDraft(
        Guid templateId,
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        var result = await dispatcher.QueryAsync<GetTemplateDraft, Result<TemplateDraftPlan>>(
            new GetTemplateDraft(TemplateId.From(templateId), TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TemplateProblems.Refused(context, result.Error);
        }
        return TypedResults.Ok(await MapWithFileTransferJobAsync(
            result.Value,
            transfers,
            jobs,
            session,
            context.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<IResult> UpdateDraft(
        Guid templateId,
        Guid operationId,
        UpdateTemplateDraftRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        if (!TryInitialization(request.Initialization, out var initialization, out var initializationRefusal))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid(initializationRefusal!));
        }

        var result = await dispatcher.SendAsync<UpdateTemplateDraft, TemplateDraftPlan>(
            new UpdateTemplateDraft(
                TemplateId.From(templateId),
                TemplateOperationId.From(operationId),
                request.Title,
                request.Description,
                initialization),
            context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TemplateProblems.Refused(context, result.Error);
        }
        return TypedResults.Ok(await MapWithFileTransferJobAsync(
            result.Value,
            transfers,
            jobs,
            session,
            context.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<IResult> UpdateDraftItem(
        Guid templateId,
        Guid operationId,
        Guid sourceId,
        UpdateTemplateItemRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<UpdateTemplateDraftItem, TemplateItemSnapshot>(
            new UpdateTemplateDraftItem(
                TemplateId.From(templateId),
                TemplateOperationId.From(operationId),
                sourceId,
                request.Title,
                request.Properties?.ToJsonString(),
                request.Schema?.ToJsonString(),
                request.Views?.ToJsonString()),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(item => TypedResults.Ok(TemplateMapping.Item(item)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> SaveDraft(
        Guid templateId,
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] ITemplateFileTransferStore transfers)
    {
        if (await transfers.HasUnreadyCopiesAsync("operation", operationId, context.RequestAborted)
            .ConfigureAwait(false))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Conflict("File copies must complete before saving this draft."));
        }
        var result = await dispatcher.SendAsync<SaveTemplateDraft, TemplateId>(
            new SaveTemplateDraft(TemplateId.From(templateId), TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(id => TypedResults.Ok(new FinalizeTemplateResponse(id.Value)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> DraftItemAuthorization(
        Guid templateId,
        Guid operationId,
        Guid sourceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<AuthorizeTemplateDraftItem, Result<TemplateItemAuthorization>>(
            new AuthorizeTemplateDraftItem(
                TemplateId.From(templateId),
                TemplateOperationId.From(operationId),
                sourceId),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(authorization => TypedResults.Ok(new TemplateItemAuthorizationResponse(
            authorization.TemplateId.Value,
            authorization.SourceId,
            authorization.ItemId.Value,
            authorization.TenantId.Value,
            authorization.PrincipalId.Value,
            authorization.WorkspaceId.Value,
            authorization.ItemType,
            authorization.CanRead,
            authorization.CanWrite)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> DiscardDraft(
        Guid templateId,
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DiscardTemplateDraft, bool>(
            new DiscardTemplateDraft(
                TemplateId.From(templateId),
                TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => TemplateProblems.Refused(context, error));
    }

    private static TemplateDraftResponse Map(TemplateDraftPlan draft) =>
        new(
            draft.OperationId.Value,
            draft.TemplateId.Value,
            draft.Title,
            draft.Description,
            draft.ExpiresAt,
            draft.Initialization ?? TemplateInitialization.Empty,
            TemplateMapping.Item(draft.Root),
            draft.ItemMappings.Select(Map).ToArray(),
            draft.BodyCopies.Select(Map).ToArray());

    private static async ValueTask<TemplateDraftResponse> MapWithFileTransferJobAsync(
        TemplateDraftPlan draft,
        ITemplateFileTransferStore transfers,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        CancellationToken cancellationToken)
    {
        var fileJob = await TemplateFileTransferJobs.EnsureAsync(
            "operation",
            draft.OperationId.Value,
            draft.ItemMappings.Any(mapping => mapping.ItemType == "file"),
            transfers,
            jobs,
            session,
            cancellationToken).ConfigureAwait(false);
        return Map(draft) with
        {
            FileTransferJobId = fileJob.JobId,
            FileTransferPending = fileJob.Pending,
        };
    }

    private static async Task<IResult> FinalizeManagedTemplates(
        Guid workspaceId,
        FinalizeManagedTemplatesRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var imports = request.Imports.Select(imported => new ManagedTemplateFinalization(
            imported.OperationId is { } operationId ? TemplateOperationId.From(operationId) : null,
            TemplateId.From(imported.TemplateId),
            imported.StableKey,
            imported.Digest,
            imported.WrittenTargetItemIds.Select(ItemId.From).ToArray())).ToArray();
        var result = await dispatcher.SendAsync<FinalizeManagedTemplates, ManagedTemplateBatchResult>(
            new FinalizeManagedTemplates(WorkspaceId.From(workspaceId), imports, request.ActiveStableKeys),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(batch => TypedResults.Ok(new FinalizeManagedTemplatesResponse(
            batch.Activated,
            batch.Unchanged,
            batch.Retired)), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> SweepExpiredStages(
        Guid workspaceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SweepExpiredTemplateStages, TemplateStageSweepResult>(
            new SweepExpiredTemplateStages(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(sweep => TypedResults.Ok(new SweepExpiredTemplateStagesResponse(
            sweep.Removed,
            sweep.ItemIds.Select(itemId => itemId.Value).ToArray())),
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> ImportAuthorization(
        Guid workspaceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>(
            new AuthorizeTemplateImport(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(authorization => TypedResults.Ok(new TemplateImportAuthorizationResponse(
            authorization.WorkspaceId.Value,
            authorization.TenantId.Value,
            authorization.PrincipalId.Value,
            authorization.CanWrite,
            authorization.CanManageTemplates)), error => TemplateProblems.Refused(context, error));
    }

    private static ItemMappingResponse Map(TemplateItemMapping mapping) =>
        new(mapping.SourceId, mapping.ItemId.Value, mapping.ItemType);

    private static BodyCopyResponse Map(TemplateBodyCopy copy) =>
        new(copy.SourceItemId.Value, copy.TargetItemId.Value, copy.ItemType,
            copy.CheckHead, copy.ExpectedHeadSeq, copy.ExpectedDocId);

    private static BodyWriteResponse Map(TemplateBodyWrite write) =>
        new(write.SourceId, write.TargetItemId.Value, write.ItemType);

    private static bool TryOrigin(string value, out TemplateOrigin origin)
    {
        origin = value == "managed" ? TemplateOrigin.Managed : TemplateOrigin.User;
        return value is "user" or "managed";
    }

    private static bool TryInitialization(
        System.Text.Json.JsonElement? json,
        out TemplateInitialization? initialization,
        out string? refusal)
    {
        if (json is null)
        {
            initialization = null;
            refusal = null;
            return true;
        }

        if (json.Value.ValueKind == System.Text.Json.JsonValueKind.Null)
        {
            initialization = null;
            refusal = "Initialization must be an object when supplied.";
            return false;
        }

        return TemplateInitializationJson.TryRead(json.Value.GetRawText(), out initialization, out refusal);
    }

    private static bool TryMode(string value, out TemplateApplicationMode mode)
    {
        mode = value == "create" ? TemplateApplicationMode.Create : TemplateApplicationMode.Merge;
        return value is "merge" or "create";
    }
}
