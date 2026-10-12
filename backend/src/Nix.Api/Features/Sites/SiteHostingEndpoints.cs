using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Sites;

/// <summary>Routes for site hostnames and first-publish approval (ADR-0063 M5).</summary>
internal static class SiteHostingEndpoints
{
    private const string Manager = " Needs workspace manager rights; a caller who cannot read the workspace gets 404.";
    private const string Operator = " Only an operator of this deployment (Nix:Sites:Operators, else the tenant administrators).";

    /// <summary>Registers the routes on the sites group.</summary>
    internal static RouteGroupBuilder MapSiteHostingEndpoints(this RouteGroupBuilder sites)
    {
        ArgumentNullException.ThrowIfNull(sites);

        sites.MapPost("/{siteId:guid}/hostnames", Add)
            .WithName("AddSiteHostname")
            .WithSummary("Attach a custom hostname")
            .WithDescription(
                "The hostname is served once a TXT record `_nix-site.<hostname>` holds its token; the response lists the records "
                + "to create. In a zone the operator's Cloudflare account manages for this workspace, Nix creates them itself." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapDelete("/{siteId:guid}/hostnames/{hostname}", Remove)
            .WithName("RemoveSiteHostname")
            .WithSummary("Detach a custom hostname")
            .WithDescription("Stops serving it and deletes only the DNS records Nix created for it." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPatch("/{siteId:guid}/hostnames/{hostname}", Update)
            .WithName("UpdateSiteHostname")
            .WithSummary("Make a hostname primary, or choose how an alias answers")
            .WithDescription(
                "The primary hostname is canonical once it is served. Other hostnames serve the same build (200) or redirect "
                + "to the canonical one (308, path and query kept). Canonical links in pages change at the next publish." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPost("/{siteId:guid}/hostnames/{hostname}/verify", Verify)
            .WithName("VerifySiteHostname")
            .WithSummary("Check a custom hostname's DNS records now")
            .WithDescription("Core looks the records up itself; nothing the client reports is trusted. One check per hostname a minute." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        sites.MapPost("/{siteId:guid}/approval", RequestApproval)
            .WithName("RequestSiteApproval")
            .WithSummary("Ask the operator to approve the first publish")
            .WithDescription("Where the deployment requires it, a first publish (and the first after an unpublish) waits for an operator; "
                + "approval publishes as the manager who asked." + Manager)
            .Produces<SiteResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapGet("/approvals", ListApprovals)
            .WithName("ListSiteApprovals")
            .WithSummary("Sites waiting for an operator's approval")
            .WithDescription("Oldest request first, within the operator's organization." + Operator)
            .Produces<SiteApprovalListResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden);
        sites.MapPost("/{siteId:guid}/approval/approve", Approve)
            .WithName("ApproveSitePublish")
            .WithSummary("Approve a first publish")
            .WithDescription("Runs the publish as the manager who asked, re-checking their manager rights; audited." + Operator)
            .Produces<SiteApprovalResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        sites.MapPost("/{siteId:guid}/approval/reject", Reject)
            .WithName("RejectSitePublish")
            .WithSummary("Reject a first publish")
            .WithDescription("The note is shown to the site's managers; audited." + Operator)
            .Produces<SiteApprovalResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return sites;
    }

    private static async Task<IResult> Send<TCommand, TValue>(
        TCommand command, HttpContext context, NixDispatcher dispatcher, Func<TValue, IResult> success)
        where TCommand : ICommand<TValue>
    {
        var result = await dispatcher.SendAsync<TCommand, TValue>(command, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? success(result.Value) : SiteEndpoints.Problem(context, result.Error);
    }

    private static Task<IResult> Add(Guid siteId, AddSiteHostnameRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<AddSiteHostname, SiteResponse>(new AddSiteHostname(siteId, request.Hostname, request.ServeMode), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> Remove(Guid siteId, string hostname, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<RemoveSiteHostname, SiteResponse>(new RemoveSiteHostname(siteId, hostname), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> Update(Guid siteId, string hostname, UpdateSiteHostnameRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<UpdateSiteHostname, SiteResponse>(
            new UpdateSiteHostname(siteId, hostname, request.ServeMode, request.Primary), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> Verify(Guid siteId, string hostname, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<VerifySiteHostname, SiteResponse>(new VerifySiteHostname(siteId, hostname), context, dispatcher, site => TypedResults.Ok(site));

    private static Task<IResult> RequestApproval(Guid siteId, RequestSiteApprovalRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<RequestSiteApproval, SiteResponse>(new RequestSiteApproval(siteId, request.AcknowledgeDisclosure), context, dispatcher, site => TypedResults.Ok(site));

    private static async Task<IResult> ListApprovals(HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ListSiteApprovals, Result<SiteApprovalListResponse>>(new ListSiteApprovals(), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : SiteEndpoints.Problem(context, result.Error);
    }

    private static Task<IResult> Approve(Guid siteId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<ApproveSitePublish, SiteApprovalResponse>(
            new ApproveSitePublish(siteId), context, dispatcher, approval => TypedResults.Accepted($"/api/v1/sites/{siteId:D}", approval));

    private static Task<IResult> Reject(Guid siteId, RejectSiteApprovalRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<RejectSitePublish, SiteApprovalResponse>(new RejectSitePublish(siteId, request.Note), context, dispatcher, approval => TypedResults.Ok(approval));
}
