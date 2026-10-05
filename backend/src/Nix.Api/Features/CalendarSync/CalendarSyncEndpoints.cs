using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.CalendarSync;

/// <summary>
/// The calendar sync routes under <c>/api/v1/me/calendar</c> (ADR-0052, Amendment 1). Every row is
/// private to its owner. The provider callback is not here: it lives on the <c>/auth</c> BFF
/// boundary (<see cref="CalendarOAuthCallbackEndpoint"/>), because a top-level provider redirect
/// carries no bearer token.
/// </summary>
internal static class CalendarSyncEndpoints
{
    internal static IEndpointRouteBuilder MapCalendarSyncEndpoints(this IEndpointRouteBuilder endpoints)
    {
        // A workspace's own view of the calendars linked into it, for its owner and the tenant's
        // administrators. Everything under /me below is one principal's own; these two are the
        // only routes that reach a link somebody else made.
        var workspace = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/calendar-links").WithTags("CalendarSync");
        workspace.MapGet("/", ListWorkspaceLinks).WithName("ListWorkspaceCalendarLinks")
            .WithDescription("The containers in the workspace that have a calendar linked into them, whoever linked it. Workspace owners and tenant administrators only; anybody else gets 'calendar.link_not_found'.");
        workspace.MapDelete("/{containerItemId:guid}", UnlinkWorkspaceLink).WithName("UnlinkWorkspaceCalendar")
            .WithDescription("Unlinks the calendar on a container, whoever linked it. 'items=keep' (the default) leaves the container and its events as ordinary items; 'items=trash' moves the container to the trash. Workspace owners and tenant administrators only.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var calendar = endpoints.MapGroup("/api/v1/me/calendar").WithTags("CalendarSync");
        calendar.MapGet("/connections", ListConnections).WithName("ListCalendarConnections");
        calendar.MapPost("/connections/{provider}/authorize", Authorize).WithName("AuthorizeCalendarConnection")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapDelete("/connections/{connectionId:guid}", DeleteConnection).WithName("DeleteCalendarConnection")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapGet("/connections/{connectionId:guid}/calendars", ListCalendars).WithName("ListExternalCalendars");
        calendar.MapGet("/links", ListLinks).WithName("ListCalendarLinks");
        calendar.MapPost("/links", CreateLink).WithName("CreateCalendarLink")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapPatch("/links/{linkId:guid}", UpdateLink).WithName("UpdateCalendarLink")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapDelete("/links/{linkId:guid}", DeleteLink).WithName("DeleteCalendarLink")
            .WithDescription(
                "Unlinks the calendar. 'items=keep' (the default) leaves the container and its events "
                + "as ordinary items; 'items=trash' moves the container to the trash. Nothing is removed "
                + "from the external calendar.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapPost("/links/{linkId:guid}/sync", SyncLink).WithName("SyncCalendarLink")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        calendar.MapGet("/links/{linkId:guid}/log", ListLog).WithName("ListCalendarLinkLog");
        return endpoints;
    }

    private static async Task<Results<Ok<CalendarConnectionsResponse>, ProblemHttpResult>> ListConnections(
        HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<ListCalendarConnections, CalendarConnectionsResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<AuthorizeCalendarResponse>, ProblemHttpResult>> Authorize(
        string provider, AuthorizeCalendarRequest? request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AuthorizeCalendarConnection, CalendarAuthorization>(
            new(provider, request?.ReturnTo), context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return Problem(context, result.Error);
        }

        // The nonce rides an HttpOnly cookie scoped to the callback path alone: a redirect that
        // arrives in another browser, or after the cookie expired, cannot complete.
        var authorization = result.Value;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Cookies.Append(CalendarOAuthState.CookieName, authorization.Nonce, new CookieOptions
        {
            HttpOnly = true,
            Secure = authorization.SecureCookie,
            SameSite = SameSiteMode.Lax,
            Path = CalendarOAuthState.CookiePath,
            Expires = authorization.ExpiresAt,
            IsEssential = true,
        });
        return TypedResults.Ok(new AuthorizeCalendarResponse(authorization.AuthorizationUrl));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteConnection(
        Guid connectionId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteCalendarConnection, bool>(new(connectionId), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<ExternalCalendarsResponse>, ProblemHttpResult>> ListCalendars(
        Guid connectionId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<ListExternalCalendars, ExternalCalendarsResponse>(new(connectionId), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<CalendarLinksResponse>, ProblemHttpResult>> ListLinks(
        HttpContext context, [FromServices] NixDispatcher dispatcher, Guid? workspaceId = null) =>
        Map(context, await dispatcher.SendAsync<ListCalendarLinks, CalendarLinksResponse>(new(workspaceId), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Created<CalendarLinkResponse>, ProblemHttpResult>> CreateLink(
        CreateCalendarLinkRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<CreateCalendarLink, CalendarLinkResponse>(new(request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<CalendarLinkResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/me/calendar/links/{value.Id:D}", value),
            error => Problem(context, error));
    }

    private static async Task<Results<Ok<CalendarLinkResponse>, ProblemHttpResult>> UpdateLink(
        Guid linkId, UpdateCalendarLinkRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<UpdateCalendarLink, CalendarLinkResponse>(new(linkId, request), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteLink(
        Guid linkId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? items = null)
    {
        if (items is not (null or "keep" or "trash"))
        {
            return Problem(context, CalendarSyncErrors.Invalid("items: must be 'keep' or 'trash'"));
        }

        var result = await dispatcher.SendAsync<DeleteCalendarLink, bool>(new(linkId, items == "trash"), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<WorkspaceCalendarLinksResponse>, ProblemHttpResult>> ListWorkspaceLinks(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<ListWorkspaceCalendarLinks, WorkspaceCalendarLinksResponse>(
            new(WorkspaceId.From(workspaceId)), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<NoContent, ProblemHttpResult>> UnlinkWorkspaceLink(
        Guid workspaceId, Guid containerItemId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? items = null)
    {
        if (items is not (null or "keep" or "trash"))
        {
            return Problem(context, CalendarSyncErrors.Invalid("items: must be 'keep' or 'trash'"));
        }

        var result = await dispatcher.SendAsync<UnlinkWorkspaceCalendar, bool>(
            new(WorkspaceId.From(workspaceId), ItemId.From(containerItemId), items == "trash"), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(context, result.Error);
    }

    private static async Task<Results<Accepted<SyncCalendarLinkResponse>, ProblemHttpResult>> SyncLink(
        Guid linkId, SyncCalendarLinkRequest? request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SyncCalendarLink, SyncCalendarLinkResponse>(
            new(linkId, request?.Full ?? false), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Accepted<SyncCalendarLinkResponse>, ProblemHttpResult>>(
            value => TypedResults.Accepted((string?)null, value),
            error => Problem(context, error));
    }

    private static async Task<Results<Ok<CalendarSyncLogPageResponse>, ProblemHttpResult>> ListLog(
        Guid linkId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null, int? limit = null) =>
        Map(context, await dispatcher.SendAsync<ListCalendarLinkLog, CalendarSyncLogPageResponse>(
            new(linkId, cursor, limit), context.RequestAborted).ConfigureAwait(false));

    private static Results<Ok<T>, ProblemHttpResult> Map<T>(HttpContext context, Result<T> result) =>
        result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var (status, title) = error.Code switch
        {
            CalendarSyncErrors.ProviderUnavailableCode when error.Message == CalendarSyncErrors.NotConfiguredMessage =>
                (StatusCodes.Status404NotFound, "Calendar provider unavailable"),
            CalendarSyncErrors.ProviderUnavailableCode => (StatusCodes.Status503ServiceUnavailable, "Calendar provider unavailable"),
            CalendarSyncErrors.ConnectionNotFoundCode => (StatusCodes.Status404NotFound, "Calendar connection unavailable"),
            CalendarSyncErrors.LinkNotFoundCode => (StatusCodes.Status404NotFound, "Calendar link unavailable"),
            CalendarSyncErrors.CalendarNotFoundCode => (StatusCodes.Status404NotFound, "Calendar not found"),
            CalendarSyncErrors.ContainerNotFoundCode => (StatusCodes.Status404NotFound, "Container unavailable"),
            CalendarSyncErrors.NeedsReauthCode => (StatusCodes.Status409Conflict, "Reconnect needed"),
            CalendarSyncErrors.ContainerSchemaConflictCode => (StatusCodes.Status409Conflict, "Container fields conflict"),
            CalendarSyncErrors.LinkExistsCode => (StatusCodes.Status409Conflict, "Already linked"),
            CalendarSyncErrors.ConflictCode => (StatusCodes.Status409Conflict, "Link changed"),
            CalendarSyncErrors.LinkInactiveCode => (StatusCodes.Status409Conflict, "Link inactive"),
            _ => (StatusCodes.Status422UnprocessableEntity, "Calendar request invalid"),
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, title, error.Message));
    }
}
