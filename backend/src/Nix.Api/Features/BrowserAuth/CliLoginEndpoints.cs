using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.BrowserAuth;

/// <summary>Explicit browser approval, single-use redemption, and revocable CLI refresh.</summary>
internal static class CliLoginEndpoints
{
    internal const string StartPolicy = "cli-login-start";
    internal const string PollPolicy = "cli-login-poll";

    internal static IEndpointRouteBuilder MapCliLoginEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var cli = endpoints.MapGroup("/auth/cli").WithTags("CliAuth");
        cli.MapPost("/start", Start).WithRequestBodyLimit(2048).Produces<CliLoginStartResponse>().ProducesProblem(400).ProducesProblem(429).ProducesProblem(503).RequireRateLimiting(StartPolicy);
        cli.MapPost("/poll", Poll).WithRequestBodyLimit(2048).Produces<CliLoginPollResponse>().ProducesProblem(429).RequireRateLimiting(PollPolicy);
        cli.MapPost("/token", Refresh).WithRequestBodyLimit(2048).Produces<CliLoginTokenResponse>().ProducesProblem(401).ProducesProblem(429).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        cli.MapPost("/logout", Logout).WithRequestBodyLimit(2048).Produces(204).ProducesProblem(429).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        cli.MapGet("/", Consent).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        cli.MapGet("/consent.js", ConsentScript).Produces<string>(200, "text/javascript");
        cli.MapPost("/approve", Approve).WithRequestBodyLimit(2048).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        return endpoints;
    }

    private static async Task<IResult> Start(CliLoginStartRequest request, HttpContext context,
        [FromServices] BrowserAuthCoordinator browser, [FromServices] CliLoginCoordinator coordinator)
    {
        NoStore(context);
        if (!browser.IsConfigured || browser.PublicOrigin is not { } origin)
        {
            return Problem(context, 503, "auth.browser_not_configured", "Browser sign-in is not configured");
        }

        if (request.ClientName is not null && request.ClientName != "nixctl")
        {
            return Problem(context, 400, "auth.cli_client_invalid", "This sign-in flow is for nixctl");
        }

        var challenge = await coordinator.StartAsync(origin, context.RequestAborted).ConfigureAwait(false);
        return challenge is null
            ? Problem(context, 429, "auth.cli_capacity", "CLI sign-in capacity is temporarily full")
            : TypedResults.Ok(challenge);
    }

    private static async Task<IResult> Poll(CliLoginPollRequest request, HttpContext context,
        [FromServices] CliLoginCoordinator coordinator)
    {
        NoStore(context);
        return TypedResults.Ok(await coordinator.PollAsync(request.DeviceCode, context.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<IResult> Refresh(CliLoginTokenRequest request, HttpContext context,
        [FromServices] CliLoginCoordinator coordinator)
    {
        NoStore(context);
        var token = await coordinator.RefreshAsync(request.RefreshToken, context.RequestAborted).ConfigureAwait(false);
        return token is null ? Problem(context, 401, "auth.cli_session_ended", "The approved CLI session has ended") : TypedResults.Ok(token);
    }

    private static async Task<IResult> Logout(CliLoginTokenRequest request, HttpContext context,
        [FromServices] CliLoginCoordinator coordinator)
    {
        NoStore(context);
        await coordinator.LogoutAsync(request.RefreshToken, context.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> Consent([FromQuery(Name = "user_code")] string? userCode, HttpContext context,
        [FromServices] BrowserAuthCoordinator browser, [FromServices] ICliLoginSessions sessions)
    {
        NoStore(context);
        var code = CliSessionSecret.NormalizeUserCode(userCode);
        if (code is null || await sessions.FindPendingAsync(BrowserSessionSecret.Hash(code), context.RequestAborted).ConfigureAwait(false) is null)
        {
            return Page(context, "Sign-in request ended", "<p>This code is invalid, expired or already used. Start a new login in nixctl.</p>", 400);
        }

        var session = await browser.ResolveAsync(context.Request.Cookies[browser.SessionCookieName], context.RequestAborted).ConfigureAwait(false);
        if (session is null)
        {
            return TypedResults.Redirect("/auth/login?returnTo=" + Uri.EscapeDataString("/auth/cli?user_code=" + code));
        }

        var displayed = code[..5] + "-" + code[5..];
        var content = $"<p>Signed in as <strong>{WebUtility.HtmlEncode(session.DisplayName)}</strong>.</p>"
            + $"<p>Check that your terminal displays <strong>{WebUtility.HtmlEncode(displayed)}</strong>.</p>"
            + "<p>Approve only a login you started. Approval lets nixctl act as you across your permitted workspaces and manage your account connections and personal access tokens, and use pets through your linked provider account, including provider usage and costs.</p>"
            + "<p>This CLI session ends with this browser session or when you run nixctl auth logout. Your workspace permissions and item locks still apply.</p>"
            + $"<form data-nix-cli-consent method=\"post\" action=\"/auth/cli/approve\"><input type=\"hidden\" name=\"userCode\" value=\"{WebUtility.HtmlEncode(code)}\">"
            + "<button name=\"decision\" value=\"approve\" type=\"submit\">Approve nixctl</button> "
            + "<button name=\"decision\" value=\"deny\" type=\"submit\">Deny</button></form>"
            + "<p id=\"cli-consent-status\" role=\"status\" aria-live=\"polite\"></p>";
        return Page(context, "Approve CLI sign-in", content, enhanceConsent: true);
    }

    private static async Task<IResult> Approve(HttpContext context, [FromServices] BrowserAuthCoordinator browser,
        [FromServices] ICliLoginSessions sessions)
    {
        NoStore(context);
        if (!SameOrigin(context, browser.PublicOrigin))
        {
            return Problem(context, 403, "auth.cross_origin_refused", "This approval must originate from the configured Nix origin");
        }

        var cookie = context.Request.Cookies[browser.SessionCookieName];
        if (await browser.ResolveAsync(cookie, context.RequestAborted).ConfigureAwait(false) is null)
        {
            return Problem(context, 401, "auth.unauthenticated", "An active browser session is required");
        }

        if (context.Request.ContentType?.Split(';')[0] != "application/x-www-form-urlencoded"
            || context.Request.ContentLength is > 2048)
        {
            return Problem(context, 400, "auth.cli_approval_invalid", "The approval form is invalid");
        }

        IFormCollection form;
        try
        {
            form = await context.Request.ReadFormAsync(new Microsoft.AspNetCore.Http.Features.FormOptions
            {
                KeyLengthLimit = 32,
                ValueLengthLimit = 128,
                ValueCountLimit = 2,
            }, context.RequestAborted).ConfigureAwait(false);
        }
        catch (InvalidDataException)
        {
            return Problem(context, 400, "auth.cli_approval_invalid", "The approval form is invalid");
        }
        var code = CliSessionSecret.NormalizeUserCode(form["userCode"].Count == 1 ? form["userCode"].ToString() : null);
        var decision = form["decision"].Count == 1 ? form["decision"].ToString() : null;
        if (code is null || decision is not ("approve" or "deny")
            || !await sessions.DecideAsync(BrowserSessionSecret.Hash(code), BrowserSessionSecret.Hash(cookie!),
                decision == "approve", context.RequestAborted).ConfigureAwait(false))
        {
            return Page(context, "Sign-in request ended", "<p>This code or browser session has expired, or the request was already decided.</p>", 400);
        }

        return Page(context, decision == "approve" ? "CLI sign-in approved" : "CLI sign-in denied",
            "<p>You can close this page and return to your terminal.</p>");
    }

    private static bool SameOrigin(HttpContext context, Uri? expected) => expected is not null
        && Uri.TryCreate(context.Request.Headers.Origin.ToString(), UriKind.Absolute, out var actual)
        && string.IsNullOrEmpty(actual.UserInfo) && string.IsNullOrEmpty(actual.Query) && string.IsNullOrEmpty(actual.Fragment)
        && actual.AbsolutePath == "/" && actual.Scheme == expected.Scheme && actual.IdnHost == expected.IdnHost && actual.Port == expected.Port;

    private static Microsoft.AspNetCore.Http.HttpResults.ContentHttpResult ConsentScript(HttpContext context)
    {
        NoStore(context);
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        return TypedResults.Content(CliConsentScript.Content, "text/javascript; charset=utf-8");
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ContentHttpResult Page(HttpContext context, string title, string content,
        int status = 200, bool enhanceConsent = false)
    {
        var nonce = enhanceConsent ? Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)) : null;
        var scriptPolicy = nonce is null ? "script-src 'none'; connect-src 'none'" : $"script-src 'nonce-{nonce}'; connect-src 'self'";
        context.Response.Headers.ContentSecurityPolicy = $"default-src 'none'; {scriptPolicy}; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
        context.Response.Headers.XFrameOptions = "DENY";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        return TypedResults.Content("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" + WebUtility.HtmlEncode(title)
            + "</title><style>body{font:17px system-ui;max-width:38rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6}button{font:inherit;padding:.6rem 1rem}strong{overflow-wrap:anywhere}</style>"
            + (nonce is null ? string.Empty : $"<script defer nonce=\"{nonce}\" src=\"/auth/cli/consent.js\"></script>")
            + "</head><body><main><h1>" + WebUtility.HtmlEncode(title) + "</h1>" + content + "</main></body></html>", "text/html; charset=utf-8", statusCode: status);
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Problem(HttpContext context, int status, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, status, code, "CLI sign-in could not be completed", detail));

    private static void NoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
    }
}
