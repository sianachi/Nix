using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.CalendarSync;

/// <summary>
/// <c>GET /auth/calendar/callback/{provider}</c> (ADR-0052 Amendment 1 A1) [SEC]: the provider's
/// redirect lands on the BFF boundary, where the browser's HttpOnly session cookie - not a bearer
/// token, which a top-level navigation cannot carry - says who is signed in.
/// </summary>
/// <remarks>
/// CSRF is covered by the protected state plus the nonce cookie: the state names the principal,
/// tenant and provider that started the connect, and only the browser that started it holds the
/// nonce. The response is never cached, and the code, tokens and state are never logged.
/// </remarks>
internal static class CalendarOAuthCallbackEndpoint
{
    internal static IEndpointRouteBuilder MapCalendarOAuthCallback(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        endpoints.MapGet("/auth/calendar/callback/{provider}", Complete).ExcludeFromDescription();
        return endpoints;
    }

    private static async Task<IResult> Complete(
        string provider,
        string? code,
        string? state,
        string? error,
        HttpContext context,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] CalendarProviderSettings settings,
        [FromServices] CalendarTokenProtector protector,
        [FromServices] CalendarProviderClients providers,
        [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(context);
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";

        var nonce = context.Request.Cookies[CalendarOAuthState.CookieName];
        context.Response.Cookies.Delete(CalendarOAuthState.CookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = settings.SecureCookies,
            SameSite = SameSiteMode.Lax,
            Path = CalendarOAuthState.CookiePath,
            IsEssential = true,
        });

        var session = await coordinator.ResolveAsync(context.Request.Cookies[coordinator.SessionCookieName], context.RequestAborted)
            .ConfigureAwait(false);
        if (session is null || session.PrincipalStatus != PrincipalStatus.Active)
        {
            return Results.Redirect("/auth/login?returnTo=" + Uri.EscapeDataString("/settings?tab=integrations"));
        }

        var payload = string.IsNullOrEmpty(state) || state.Length > 8192
            ? null
            : CalendarOAuthState.Decode(protector.UnprotectState(state));
        if (payload is null
            || !CalendarOAuthState.Accepts(payload, nonce, session.TenantId.Value, session.PrincipalId.Value, provider, clock.GetUtcNow()))
        {
            return Results.Redirect(WithStatus("/settings?tab=integrations", "failed"));
        }

        if (!string.IsNullOrEmpty(error))
        {
            return Results.Redirect(WithStatus(payload.ReturnTo, "cancelled"));
        }

        if (string.IsNullOrEmpty(code) || code.Length > 4096 || providers.For(provider) is not { } client || !settings.IsAvailable(provider))
        {
            return Results.Redirect(WithStatus(payload.ReturnTo, "failed"));
        }

        CalendarTokenGrant grant;
        try
        {
            grant = await client.ExchangeCodeAsync(code, payload.Verifier, settings.RedirectUri(provider), context.RequestAborted)
                .ConfigureAwait(false);
        }
        catch (CalendarProviderUnavailableException)
        {
            return Results.Redirect(WithStatus(payload.ReturnTo, "failed"));
        }

        // The connection row's own bounds, checked here so a grant it would refuse is a failed
        // connect rather than a server error from the insert.
        if (!Storable(grant))
        {
            return Results.Redirect(WithStatus(payload.ReturnTo, "failed"));
        }

        // The same unit of work the coordinator uses: the session's own tenant and principal,
        // set before the transaction so row security scopes every statement in it.
        await isolated.RunAsync(
            NixSessionContext.ForTenant(session.TenantId, session.PrincipalId),
            async (services, token) =>
            {
                var now = clock.GetUtcNow();
                await services.GetRequiredService<ICalendarSyncStore>().UpsertConnectionAsync(
                    session.TenantId,
                    session.PrincipalId,
                    new CalendarConnectionGrant(
                        provider,
                        grant.Subject,
                        grant.Email,
                        grant.Scopes,
                        protector.ProtectRefreshToken(grant.RefreshToken),
                        protector.ProtectAccessToken(grant.AccessToken),
                        now + grant.ExpiresIn),
                    now,
                    token).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(true, Commit: true);
            },
            context.RequestAborted).ConfigureAwait(false);

        return Results.Redirect(WithStatus(payload.ReturnTo, "connected"));
    }

    private static bool Storable(CalendarTokenGrant grant) =>
        !string.IsNullOrWhiteSpace(grant.Subject)
        && grant.Subject.Length <= 255
        && !grant.Subject.Any(char.IsControl)
        && grant.Email.Length <= 320
        && !grant.Email.Contains('\0', StringComparison.Ordinal)
        && grant.Scopes.Length <= 1000
        && !grant.Scopes.Contains('\0', StringComparison.Ordinal);

    private static string WithStatus(string returnTo, string status) =>
        returnTo + (returnTo.Contains('?', StringComparison.Ordinal) ? "&" : "?") + "calendar_status=" + status;
}
