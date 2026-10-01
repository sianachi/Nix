using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Notifications;

internal static class NotificationEndpoints
{
    internal static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var me = endpoints.MapGroup("/api/v1/me").WithTags("Notifications");

        me.MapGet("/preferences", GetPreferences).WithName("GetPreferences");
        me.MapPut("/preferences", SavePreferences).WithName("SavePreferences")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        me.MapGet("/notifications", ListNotifications).WithName("ListNotifications");
        me.MapPost("/notifications/{notificationId:guid}/read", MarkRead).WithName("MarkNotificationRead")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        me.MapPost("/notifications/read-all", MarkAllRead).WithName("MarkAllNotificationsRead")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        // Not rate limited by the writes policy, and bounded per principal instead of by that
        // limiter: see NotificationWatchGate. Modelled on GET /me/pets/runtime/watch -
        // NixUnitOfWorkMiddleware keeps one Postgres connection and transaction open for the
        // whole wait, up to 20 s.
        me.MapGet("/notifications/watch", Watch).WithName("WatchNotifications")
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        me.MapPost("/push-subscriptions", AddPushSubscription).WithName("AddPushSubscription")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        me.MapDelete("/push-subscriptions", RemovePushSubscription).WithName("RemovePushSubscription")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        me.MapGet("/push/public-key", GetPushPublicKey).WithName("GetPushPublicKey")
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    private static async Task<Ok<PrincipalPreferencesResponse>> GetPreferences(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher.QueryAsync<GetPreferences, PrincipalPreferencesResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PrincipalPreferencesResponse>, ProblemHttpResult>> SavePreferences(
        SavePreferencesRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
            new(request.ExpectedRevision, request.Preferences), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PrincipalPreferencesResponse>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context,
                error.Code == "notifications.preferences_conflict" ? StatusCodes.Status409Conflict : StatusCodes.Status422UnprocessableEntity,
                error.Code, "Preferences could not be saved", error.Message)));
    }

    private static async Task<Ok<NotificationsPageResponse>> ListNotifications(
        HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null, bool unreadOnly = false) =>
        TypedResults.Ok(await dispatcher.QueryAsync<GetNotifications, NotificationsPageResponse>(
            new(cursor, unreadOnly), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<NotificationReadResponse>, ProblemHttpResult>> MarkRead(
        Guid notificationId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(notificationId), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<NotificationReadResponse>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status404NotFound, error.Code, "Notification is unavailable", error.Message)));
    }

    private static async Task<Ok<NotificationReadResponse>> MarkAllRead(HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<MarkAllNotificationsRead, NotificationReadResponse>(new(), context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(result.Value);
    }

    private static async Task<Results<Ok<NotificationsPageResponse>, ProblemHttpResult>> Watch(
        HttpContext context, [FromServices] NixDispatcher dispatcher, [FromServices] INixSessionContextAccessor session,
        [FromServices] NotificationWatchGate gate, long after = 0)
    {
        context.Response.Headers.CacheControl = "no-store";
        var principalId = (session.Current ?? throw new InvalidOperationException("A session is required.")).PrincipalId.Value;
        if (!gate.TryEnter(principalId))
        {
            context.Response.Headers.RetryAfter = "5";
            return TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status429TooManyRequests,
                "notifications.too_many_watches", "Too many active watches", "Close another tab and try again."));
        }

        try
        {
            var page = await dispatcher.QueryAsync<WatchNotifications, NotificationsPageResponse>(new(after), context.RequestAborted).ConfigureAwait(false);
            return TypedResults.Ok(page);
        }
        finally
        {
            gate.Exit(principalId);
        }
    }

    private static async Task<Results<Ok<PushSubscriptionDto>, ProblemHttpResult>> AddPushSubscription(
        AddPushSubscriptionRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var userAgent = context.Request.Headers.UserAgent.ToString();
        if (userAgent.Length > 400)
        {
            userAgent = userAgent[..400];
        }

        var result = await dispatcher.SendAsync<AddPushSubscription, PushSubscriptionDto>(
            new(request.Endpoint, request.P256dh, request.Auth, userAgent), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PushSubscriptionDto>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status422UnprocessableEntity, error.Code, "Device could not be registered", error.Message)));
    }

    private static async Task<Results<Ok, ProblemHttpResult>> RemovePushSubscription(
        [FromBody] RemovePushSubscriptionRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RemovePushSubscription, bool>(new(request.Endpoint), context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure || !result.Value)
        {
            return TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status404NotFound,
                "notifications.subscription_not_found", "Device is unavailable", "That device is not registered."));
        }

        return TypedResults.Ok();
    }

    private static Results<Ok<PushPublicKeyResponse>, ProblemHttpResult> GetPushPublicKey(HttpContext context, [FromServices] IConfiguration configuration)
    {
        var key = configuration["Nix:Push:VapidPublicKey"];
        if (string.IsNullOrWhiteSpace(key))
        {
            return TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status404NotFound,
                "push.unavailable", "Push is unavailable", "This server has not configured Web Push."));
        }

        return TypedResults.Ok(new PushPublicKeyResponse(key));
    }
}
