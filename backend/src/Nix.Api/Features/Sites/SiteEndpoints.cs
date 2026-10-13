using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>
/// Route registration for sites: static publications of an item subtree (ADR-0063). Every
/// mutation is a workspace manager action, decided by Core alone and written to the audit log.
/// </summary>
internal static class SiteEndpoints
{
    private const string Manager = " Needs workspace manager rights; a caller who cannot read the workspace gets 404.";

    /// <summary>Registers the site routes on <paramref name="endpoints"/>.</summary>
    internal static IEndpointRouteBuilder MapSiteEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/api/v1/items/{itemId:guid}/site", GetForItem)
            .AddEndpointFilter(SiteGate.RequireEnabled)
            .WithTags("Sites")
            .WithName("GetItemSite")
            .WithSummary("The site rooted at an item")
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        endpoints.MapGet("/api/v1/workspaces/{workspaceId:guid}/sites", ListForWorkspace)
            .AddEndpointFilter(SiteGate.RequireEnabled)
            .WithTags("Sites")
            .WithName("ListWorkspaceSites")
            .WithSummary("The sites of a workspace")
            .Produces<SiteListResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        var sites = endpoints.MapGroup("/api/v1/sites").WithTags("Sites");
        sites.AddEndpointFilter(SiteGate.RequireEnabled);
        sites.MapPost(string.Empty, Create)
            .WithName("CreateSite")
            .WithSummary("Make an item's subtree a site")
            .WithDescription(
                "Creates a draft site with its default hostname under the sites domain. Nothing is public until it is published." + Manager)
            .Produces<SiteResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapGet("/{siteId:guid}", Get)
            .WithName("GetSite")
            .WithSummary("Read a site")
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        sites.MapPatch("/{siteId:guid}", Update)
            .WithName("UpdateSite")
            .WithSummary("Change a site's settings, republish mode, exclusions or dated collections")
            .WithDescription("A field that is left out is left alone. Turning on automatic republish makes the caller the principal the rebuilds run as." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapDelete("/{siteId:guid}", Delete)
            .WithName("DeleteSite")
            .WithSummary("Delete a site that is not live")
            .WithDescription("Refused while the site is live, building, or still has files being deleted." + Manager)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPut("/{siteId:guid}/hostnames", SetHostnames)
            .WithName("SetSiteHostnames")
            .WithSummary("Replace a site's custom hostnames")
            .WithDescription("A custom hostname is served only once its ownership is verified; until then it is listed as pending." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPost("/{siteId:guid}/publish", Publish)
            .WithName("PublishSite")
            .WithSummary("Build the site and take it live")
            .WithDescription(
                "Fixes what the caller can read as an immutable manifest and queues a build. Locked, trashed, excluded and "
                + "future-dated items are never included. The first publish needs 'acknowledgeDisclosure': search engines and "
                + "web archives may keep a copy of public content." + Manager)
            .Produces<SiteBuildResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPost("/{siteId:guid}/rollback", Rollback)
            .WithName("RollbackSite")
            .WithSummary("Serve a previous build again")
            .WithDescription("Only a previous build that has not been retired can be served again." + Manager)
            .Produces<SiteBuildResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPost("/{siteId:guid}/unpublish", Unpublish)
            .WithName("UnpublishSite")
            .WithSummary("Withdraw the site")
            .WithDescription("Removes the host manifests and deletes the builds. Search engines and archives may still hold copies." + Manager)
            .Produces<SiteResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapGet("/{siteId:guid}/builds", ListBuildsRoute)
            .WithName("ListSiteBuilds")
            .WithSummary("A site's builds, newest first")
            .Produces<SiteBuildListResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        sites.MapGet("/{siteId:guid}/builds/{buildId:guid}", GetBuildRoute)
            .WithName("GetSiteBuild")
            .WithSummary("One build of a site")
            .Produces<SiteBuildResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        sites.MapGet("/{siteId:guid}/pages", ListPagesRoute)
            .WithName("ListSitePages")
            .WithSummary("A site's page paths")
            .Produces<SitePageListResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        sites.MapPut("/{siteId:guid}/pages/{itemId:guid}/path", SetPath)
            .WithName("SetSitePagePath")
            .WithSummary("Set and pin one page's path")
            .WithDescription("The old path becomes a permanent redirect." + Manager)
            .Produces<SitePageResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapSiteHostingEndpoints();

        return endpoints;
    }

    /// <summary>Maps a sites failure to problem details: the code decides the status.</summary>
    internal static IResult Problem(HttpContext context, NixError error) =>
        TypedResults.Problem(ApiProblem.Create(
            context, SiteErrors.StatusFor(error.Code), error.Code, "Request refused", error.Message));

    private static async Task<IResult> Reply<TCommand, TValue>(
        TCommand command,
        HttpContext context,
        NixDispatcher dispatcher,
        Func<TValue, IResult> success)
        where TCommand : ICommand<TValue>
    {
        Result<TValue> result;
        try
        {
            result = await dispatcher.SendAsync<TCommand, TValue>(command, context.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception exception) when (SiteErrors.IsDeadlock(exception))
        {
            // The unit of work rolls back on the refusal; the caller may simply retry.
            return Problem(context, SiteErrors.Deadlocked());
        }

        return result.IsSuccess ? success(result.Value) : Problem(context, result.Error);
    }

    private static async Task<IResult> Ask<TQuery, TValue>(
        TQuery query,
        HttpContext context,
        NixDispatcher dispatcher)
        where TQuery : IQuery<Result<TValue>>
    {
        var result = await dispatcher.QueryAsync<TQuery, Result<TValue>>(query, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
    }

    private static Task<IResult> GetForItem(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<GetItemSite, SiteResponse>(new GetItemSite(itemId), context, dispatcher);

    private static Task<IResult> ListForWorkspace(Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<ListSites, SiteListResponse>(new ListSites(workspaceId), context, dispatcher);

    private static Task<IResult> Create(CreateSiteRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<CreateSite, SiteResponse>(
            new CreateSite(request), context, dispatcher, site => TypedResults.Created($"/api/v1/sites/{site.Id:D}", site));

    private static Task<IResult> Get(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<GetSite, SiteResponse>(new GetSite(siteId), context, dispatcher);

    private static Task<IResult> Update(Guid siteId, UpdateSiteRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<UpdateSite, SiteResponse>(new UpdateSite(siteId, request), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> Delete(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<DeleteSite, Guid>(new DeleteSite(siteId), context, dispatcher, _ => TypedResults.NoContent());

    private static Task<IResult> SetHostnames(Guid siteId, SetSiteHostnamesRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<SetSiteHostnames, SiteResponse>(
            new SetSiteHostnames(siteId, request.Hostnames), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> Publish(Guid siteId, PublishSiteRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<PublishSite, SiteBuildResponse>(
            new PublishSite(siteId, request.IdempotencyKey, request.RefreshPaths, request.AcknowledgeDisclosure, "manual"),
            context,
            dispatcher,
            build => TypedResults.Accepted($"/api/v1/sites/{siteId:D}/builds/{build.Id:D}", build));

    private static Task<IResult> Rollback(Guid siteId, RollbackSiteRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<RollbackSite, SiteBuildResponse>(
            new RollbackSite(siteId, request.BuildId),
            context,
            dispatcher,
            build => TypedResults.Accepted($"/api/v1/sites/{siteId:D}/builds/{build.Id:D}", build));

    private static Task<IResult> Unpublish(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<UnpublishSite, SiteResponse>(
            new UnpublishSite(siteId), context, dispatcher, site => TypedResults.Accepted($"/api/v1/sites/{siteId:D}", site));

    private static Task<IResult> ListBuildsRoute(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<ListBuilds, SiteBuildListResponse>(new ListBuilds(siteId), context, dispatcher);

    private static Task<IResult> GetBuildRoute(Guid siteId, Guid buildId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<GetBuild, SiteBuildResponse>(new GetBuild(siteId, buildId), context, dispatcher);

    private static Task<IResult> ListPagesRoute(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Ask<ListPages, SitePageListResponse>(new ListPages(siteId), context, dispatcher);

    private static Task<IResult> SetPath(Guid siteId, Guid itemId, SetSitePagePathRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Reply<SetSitePagePath, SitePageResponse>(
            new SetSitePagePath(siteId, itemId, request.Path), context, dispatcher, page => TypedResults.Ok(page));
}
