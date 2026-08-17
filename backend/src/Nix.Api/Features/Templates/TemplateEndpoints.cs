using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Public catalog and internal template-orchestration routes.</summary>
internal static class TemplateEndpoints
{
    internal static IEndpointRouteBuilder MapTemplateEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var workspace = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/templates")
            .WithTags("Templates");
        workspace.MapGet("/", List)
            .WithName("ListTemplates")
            .WithSummary("Templates available in a workspace")
            .Produces<TemplateCatalogResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        var templates = endpoints.MapGroup("/api/v1/templates")
            .WithTags("Templates");
        templates.MapGet("/{templateId:guid}", Detail)
            .WithName("GetTemplate")
            .Produces<TemplateDetailResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
        templates.MapDelete("/{templateId:guid}", Delete)
            .WithName("DeleteTemplate")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        templates.MapPost("/{templateId:guid}/preflight", Preflight)
            .WithName("PreflightTemplateApplication")
            .Produces<TemplatePreflightResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        templates.MapGet("/{templateId:guid}/items/{sourceId:guid}", GetItem)
            .WithName("GetTemplateItem")
            .Produces<TemplateItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);
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

        return endpoints;
    }

    private static async Task<IResult> List(
        Guid workspaceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ListTemplates, Result<TemplateLibrarySnapshot>>(
            new ListTemplates(WorkspaceId.From(workspaceId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            library => TypedResults.Ok(new TemplateCatalogResponse(
                library.Templates.Select(TemplateMapping.Summary).ToArray(),
                new TemplateLibraryCapabilitiesResponse(library.CanManage))),
            error => Problem(context, error));
    }

    private static async Task<IResult> Detail(
        Guid templateId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<GetTemplate, Result<TemplateDetailSnapshot>>(
            new GetTemplate(TemplateId.From(templateId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            template => TypedResults.Ok(TemplateMapping.Detail(template)),
            error => Problem(context, error));
    }

    private static async Task<IResult> Delete(
        Guid templateId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteTemplate, bool>(
            new DeleteTemplate(TemplateId.From(templateId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static async Task<IResult> Preflight(
        Guid templateId,
        TemplatePreflightRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMode(request.Mode, out var mode))
        {
            return Problem(context, TemplateErrors.Invalid("Mode must be 'merge' or 'create'."));
        }

        var result = await dispatcher.QueryAsync<PreflightTemplateApplication, Result<TemplatePreflight>>(
            new PreflightTemplateApplication(
                TemplateId.From(templateId),
                mode,
                request.TargetItemId is { } target ? ItemId.From(target) : null,
                request.ParentItemId is { } parent ? ItemId.From(parent) : null),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            preflight => TypedResults.Ok(new TemplatePreflightResponse(
                preflight.TemplateId.Value,
                Mode(preflight.Mode),
                new TemplateAdditionsResponse(
                    preflight.FieldAdditions,
                    preflight.ViewAdditions,
                    preflight.ItemAdditions),
                preflight.Conflicts,
                preflight.CanApply)),
            error => Problem(context, error));
    }

    private static async Task<IResult> GetItem(
        Guid templateId,
        Guid sourceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<GetTemplateItem, Result<TemplateItemSnapshot>>(
            new GetTemplateItem(TemplateId.From(templateId), sourceId),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            item => TypedResults.Ok(TemplateMapping.Item(item)),
            error => Problem(context, error));
    }

    private static async Task<IResult> BeginCapture(
        BeginTemplateCaptureRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<BeginTemplateCapture, TemplateCapturePlan>(
            new BeginTemplateCapture(
                WorkspaceId.From(request.WorkspaceId),
                ItemId.From(request.SourceItemId),
                request.Title,
                request.Description,
                request.IncludeBody,
                request.IncludeChildren,
                request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            plan => TypedResults.Ok(new BeginTemplateCaptureResponse(
                plan.OperationId.Value,
                plan.TemplateId.Value,
                plan.ItemMappings.Select(Map).ToArray(),
                plan.BodyCopies.Select(Map).ToArray())),
            error => Problem(context, error));
    }

    private static async Task<IResult> BeginImport(
        BeginTemplateImportRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!TryOrigin(request.Template.Origin, out var origin))
        {
            return Problem(context, TemplateErrors.Invalid("Origin must be 'user' or 'managed'."));
        }

        var descriptor = new TemplateImportDescriptor(
            request.Template.StableKey,
            request.Template.Title,
            request.Template.Description,
            origin,
            request.Template.ManagedSource,
            request.Template.Digest,
            request.Template.IncludeBody,
            request.Template.IncludeChildren);
        var items = new TemplateImportItem[request.Items.Count];
        for (var index = 0; index < request.Items.Count; index++)
        {
            var item = request.Items[index];
            if (!TemplateSequence.TryParse(item.Seq, out var sequence))
            {
                return Problem(
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
                item.HasBody);
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
            error => Problem(context, error));
    }

    private static async Task<IResult> BeginApplication(
        BeginTemplateApplicationRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMode(request.Mode, out var mode))
        {
            return Problem(context, TemplateErrors.Invalid("Mode must be 'merge' or 'create'."));
        }

        var result = await dispatcher.SendAsync<BeginTemplateApplication, TemplateApplicationPlan>(
            new BeginTemplateApplication(
                TemplateId.From(request.TemplateId),
                mode,
                request.TargetItemId is { } target ? ItemId.From(target) : null,
                request.ParentItemId is { } parent ? ItemId.From(parent) : null,
                request.Title,
                request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            plan =>
            {
                var mappings = plan.ItemMappings.Select(Map).ToArray();
                return TypedResults.Ok(new BeginTemplateApplicationResponse(
                    plan.ApplicationId.Value,
                    plan.TemplateId.Value,
                    plan.TargetItemId.Value,
                    plan.AlreadyApplied,
                    plan.CreatedItems.Select(Map).ToArray(),
                    mappings,
                    plan.BodyCopies.Select(Map).ToArray()));
            },
            error => Problem(context, error));
    }

    private static async Task<IResult> FinalizeOperation(
        Guid operationId,
        FinalizeTemplateBodiesRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<FinalizeTemplateOperation, TemplateId>(
            new FinalizeTemplateOperation(
                TemplateOperationId.From(operationId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray()),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            templateId => TypedResults.Ok(new FinalizeTemplateResponse(templateId.Value)),
            error => Problem(context, error));
    }

    private static async Task<IResult> FinalizeApplication(
        Guid applicationId,
        FinalizeTemplateBodiesRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<FinalizeTemplateApplication, ItemId>(
            new FinalizeTemplateApplication(
                TemplateApplicationId.From(applicationId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray()),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            itemId => TypedResults.Ok(new FinalizeTemplateApplicationResponse(itemId.Value)),
            error => Problem(context, error));
    }

    private static async Task<IResult> AbortOperation(
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
            new AbortTemplateOperation(TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static async Task<IResult> AbortApplication(
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AbortTemplateApplication, bool>(
            new AbortTemplateApplication(TemplateApplicationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => Problem(context, error));
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
            authorization.CanWrite)), error => Problem(context, error));
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
            authorization.CanWrite)), error => Problem(context, error));
    }

    private static async Task<IResult> Export(
        Guid templateId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ExportTemplate, Result<TemplateExportSnapshot>>(
            new ExportTemplate(TemplateId.From(templateId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(snapshot => TypedResults.Ok(new TemplateExportResponse(
            snapshot.TemplateId.Value,
            snapshot.WorkspaceId.Value,
            snapshot.StableKey,
            snapshot.Title,
            snapshot.Description,
            TemplateMapping.Origin(snapshot.Origin),
            snapshot.Revision,
            snapshot.IncludeBody,
            snapshot.IncludeChildren,
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
                item.HasBody)).ToArray())), error => Problem(context, error));
    }

    private static async Task<IResult> BeginDraft(
        Guid templateId,
        BeginTemplateDraftRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<BeginTemplateDraft, TemplateDraftPlan>(
            new BeginTemplateDraft(TemplateId.From(templateId), request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(draft => TypedResults.Ok(Map(draft)), error => Problem(context, error));
    }

    private static async Task<IResult> GetDraft(
        Guid templateId,
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<GetTemplateDraft, Result<TemplateDraftPlan>>(
            new GetTemplateDraft(TemplateId.From(templateId), TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(draft => TypedResults.Ok(Map(draft)), error => Problem(context, error));
    }

    private static async Task<IResult> UpdateDraft(
        Guid templateId,
        Guid operationId,
        UpdateTemplateDraftRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<UpdateTemplateDraft, TemplateDraftPlan>(
            new UpdateTemplateDraft(
                TemplateId.From(templateId),
                TemplateOperationId.From(operationId),
                request.Title,
                request.Description),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(draft => TypedResults.Ok(Map(draft)), error => Problem(context, error));
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
        return result.Match<IResult>(item => TypedResults.Ok(TemplateMapping.Item(item)), error => Problem(context, error));
    }

    private static async Task<IResult> SaveDraft(
        Guid templateId,
        Guid operationId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SaveTemplateDraft, TemplateId>(
            new SaveTemplateDraft(TemplateId.From(templateId), TemplateOperationId.From(operationId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(id => TypedResults.Ok(new FinalizeTemplateResponse(id.Value)), error => Problem(context, error));
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
            authorization.CanWrite)), error => Problem(context, error));
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
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static TemplateDraftResponse Map(TemplateDraftPlan draft) =>
        new(
            draft.OperationId.Value,
            draft.TemplateId.Value,
            draft.Title,
            draft.Description,
            draft.ExpiresAt,
            TemplateMapping.Item(draft.Root),
            draft.ItemMappings.Select(Map).ToArray(),
            draft.BodyCopies.Select(Map).ToArray());

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
            batch.Retired)), error => Problem(context, error));
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
            error => Problem(context, error));
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
            authorization.CanManageTemplates)), error => Problem(context, error));
    }

    private static ItemMappingResponse Map(TemplateItemMapping mapping) =>
        new(mapping.SourceId, mapping.ItemId.Value, mapping.ItemType);

    private static BodyCopyResponse Map(TemplateBodyCopy copy) =>
        new(copy.SourceItemId.Value, copy.TargetItemId.Value, copy.ItemType);

    private static BodyWriteResponse Map(TemplateBodyWrite write) =>
        new(write.SourceId, write.TargetItemId.Value, write.ItemType);

    private static bool TryMode(string value, out TemplateApplicationMode mode)
    {
        mode = value == "create" ? TemplateApplicationMode.Create : TemplateApplicationMode.Merge;
        return value is "merge" or "create";
    }

    private static TemplateApplicationModeResponse Mode(TemplateApplicationMode mode) => mode switch
    {
        TemplateApplicationMode.Merge => TemplateApplicationModeResponse.Merge,
        TemplateApplicationMode.Create => TemplateApplicationModeResponse.Create,
        _ => throw new ArgumentOutOfRangeException(nameof(mode), mode, "Unknown template application mode."),
    };

    private static bool TryMode(
        TemplateApplicationModeResponse value,
        out TemplateApplicationMode mode)
    {
        mode = value == TemplateApplicationModeResponse.Create
            ? TemplateApplicationMode.Create
            : TemplateApplicationMode.Merge;
        return value is TemplateApplicationModeResponse.Merge or TemplateApplicationModeResponse.Create;
    }

    private static bool TryOrigin(string value, out TemplateOrigin origin)
    {
        origin = value == "managed" ? TemplateOrigin.Managed : TemplateOrigin.User;
        return value is "user" or "managed";
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Problem(
        HttpContext context,
        NixError error)
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
            "Template request refused",
            error.Message));
    }
}
