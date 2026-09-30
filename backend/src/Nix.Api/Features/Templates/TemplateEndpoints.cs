using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions.Templates;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Templates;

/// <summary>Public template catalog routes: list, capture preview, detail, delete, preflight and item reads.</summary>
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
        workspace.MapGet("/capture-preview/{sourceItemId:guid}", CapturePreview)
            .WithName("PreviewTemplateCapture")
            .Produces<TemplateCapturePreviewResponse>(StatusCodes.Status200OK)
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

        // Wired here rather than in InternalEndpoints because this is where the family was registered;
        // moving it needs proof that its service-authentication boundary is unchanged.
        TemplateInternalEndpoints.MapInternalTemplateEndpoints(endpoints);

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
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> CapturePreview(
        Guid workspaceId,
        Guid sourceItemId,
        bool includeChildren,
        bool? excludeSampleDescendants,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<PreviewTemplateCapture, Result<TemplateCaptureSnapshot>>(
            new PreviewTemplateCapture(WorkspaceId.From(workspaceId), ItemId.From(sourceItemId),
                includeChildren, excludeSampleDescendants ?? false),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
            snapshot => TypedResults.Ok(new TemplateCapturePreviewResponse(
                snapshot.Fingerprint, snapshot.CaptureFingerprint, snapshot.SourceTitle, snapshot.ItemCount)),
            error => TemplateProblems.Refused(context, error));
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
            error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> Delete(
        Guid templateId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteTemplate, bool>(
            new DeleteTemplate(TemplateId.From(templateId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(_ => TypedResults.NoContent(), error => TemplateProblems.Refused(context, error));
    }

    private static async Task<IResult> Preflight(
        Guid templateId,
        TemplatePreflightRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMode(request.Mode, out var mode))
        {
            return TemplateProblems.Refused(context, TemplateErrors.Invalid("Mode must be 'merge' or 'create'."));
        }

        var result = await dispatcher.QueryAsync<PreflightTemplateApplication, Result<TemplatePreflight>>(
            new PreflightTemplateApplication(
                TemplateId.From(templateId),
                mode,
                request.TargetItemId is { } target ? ItemId.From(target) : null,
                request.ParentItemId is { } parent ? ItemId.From(parent) : null,
                request.Title,
                request.Inputs,
                request.ExpectedRevision),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(
                preflight => TypedResults.Ok(new TemplatePreflightResponse(
                preflight.TemplateId.Value,
                TemplateMapping.ResolutionOrEmpty(preflight.Resolution).TemplateRevision,
                Mode(preflight.Mode),
                new TemplateAdditionsResponse(
                    preflight.FieldAdditions,
                    preflight.ViewAdditions,
                    preflight.ItemAdditions),
                preflight.Conflicts,
                preflight.CanApply,
                TemplateMapping.ResolutionOrEmpty(preflight.Resolution).Values,
                (preflight.InitializationPreview ?? []).Select(TemplateMapping.Preview).ToArray(),
                TemplateMapping.ResolutionOrEmpty(preflight.Resolution).TextBindings,
                TemplateMapping.ResolutionOrEmpty(preflight.Resolution).ReferenceMappings)),
            error => TemplateProblems.Refused(context, error));
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
            error => TemplateProblems.Refused(context, error));
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
}
