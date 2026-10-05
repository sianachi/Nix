using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A scriptable stand-in for Google's and Microsoft's token, revoke and calendar-list endpoints,
/// listening on a loopback port so Core's provider clients can be pointed at it through their
/// configurable origins. Records every call it answers; never logs a token.
/// </summary>
internal sealed class FakeCalendarProviderServer : IAsyncDisposable
{
    private readonly WebApplication _app;

    private FakeCalendarProviderServer(WebApplication app, string origin)
    {
        _app = app;
        Origin = origin;
    }

    /// <summary>Gets the origin to configure as every provider origin.</summary>
    public string Origin { get; }

    /// <summary>Gets every call answered, as <c>METHOD path</c> plus the form body for token calls.</summary>
    public ConcurrentQueue<FakeProviderCall> Calls { get; } = new();

    /// <summary>What the next refresh answers: <c>ok</c>, <c>invalid_grant</c>, <c>server_error</c> or <c>rotate</c>.</summary>
    public string RefreshOutcome { get; set; } = "ok";

    /// <summary>The calendars the listing endpoints return.</summary>
    public IReadOnlyList<(string Id, string Name, bool Primary, bool Writable)> Calendars { get; set; } =
    [
        ("primary", "Work", true, true),
        ("holidays", "Holidays", false, false),
    ];

    /// <summary>The account identity the id_token names.</summary>
    public string Subject { get; set; } = "google-subject-1";

    /// <summary>Starts the server.</summary>
    public static async Task<FakeCalendarProviderServer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var app = builder.Build();
        FakeCalendarProviderServer? server = null;
        app.Use(async (context, next) =>
        {
            var form = context.Request.HasFormContentType
                ? (await context.Request.ReadFormAsync(context.RequestAborted)).ToDictionary(pair => pair.Key, pair => pair.Value.ToString())
                : [];
            server!.Calls.Enqueue(new FakeProviderCall(
                context.Request.Method,
                context.Request.Path.Value ?? string.Empty,
                context.Request.QueryString.Value ?? string.Empty,
                form,
                context.Request.Headers.Authorization.ToString()));
            await next(context);
        });
        app.MapPost("/token", (HttpContext context) => server!.Token(context, microsoft: false));
        app.MapPost("/{tenant}/oauth2/v2.0/token", (HttpContext context, string tenant) => server!.Token(context, microsoft: true));
        app.MapPost("/revoke", () => Results.Ok());
        app.MapGet("/calendar/v3/users/me/calendarList", () => Results.Json(new
        {
            items = server!.Calendars.Select(calendar => new
            {
                id = calendar.Id,
                summary = calendar.Name,
                primary = calendar.Primary,
                accessRole = calendar.Writable ? "owner" : "reader",
            }),
        }));
        app.MapGet("/v1.0/me/calendars", () => Results.Json(new
        {
            value = server!.Calendars.Select(calendar => new
            {
                id = calendar.Id,
                name = calendar.Name,
                canEdit = calendar.Writable,
                isDefaultCalendar = calendar.Primary,
            }),
        }));
        await app.StartAsync();
        var address = app.Urls.Single();
        server = new FakeCalendarProviderServer(app, address.TrimEnd('/') + "/");
        return server;
    }

    /// <summary>Calls whose path ends with <paramref name="suffix"/>.</summary>
    public IReadOnlyList<FakeProviderCall> CallsTo(string suffix) =>
        [.. Calls.Where(call => call.Path.EndsWith(suffix, StringComparison.Ordinal))];

    private IResult Token(HttpContext context, bool microsoft)
    {
        var form = context.Request.Form.ToDictionary(pair => pair.Key, pair => pair.Value.ToString());
        var grant = form.GetValueOrDefault("grant_type");
        if (grant == "refresh_token")
        {
            return RefreshOutcome switch
            {
                "invalid_grant" => Results.Json(new { error = "invalid_grant" }, statusCode: StatusCodes.Status400BadRequest),
                "server_error" => Results.Json(new { error = "server_error" }, statusCode: StatusCodes.Status500InternalServerError),
                "rotate" => Results.Json(new
                {
                    access_token = "access-refreshed",
                    expires_in = 3599,
                    refresh_token = "refresh-rotated",
                    token_type = "Bearer",
                }),
                _ => Results.Json(new { access_token = "access-refreshed", expires_in = 3599, token_type = "Bearer" }),
            };
        }

        if (grant != "authorization_code" || form.GetValueOrDefault("code") != "good-code" || string.IsNullOrEmpty(form.GetValueOrDefault("code_verifier")))
        {
            return Results.Json(new { error = "invalid_grant" }, statusCode: StatusCodes.Status400BadRequest);
        }

        var claims = microsoft
            ? JsonSerializer.Serialize(new { tid = "tenant-1", oid = Subject, preferred_username = "person@outlook.test" })
            : JsonSerializer.Serialize(new { sub = Subject, email = "person@gmail.test" });
        var idToken = $"{Encode("{\"alg\":\"none\"}")}.{Encode(claims)}.";
        return Results.Json(new
        {
            access_token = "access-initial",
            refresh_token = "refresh-initial",
            expires_in = 3599,
            scope = microsoft ? "openid email offline_access Calendars.ReadWrite" : "openid email https://www.googleapis.com/auth/calendar.events",
            id_token = idToken + "sig",
            token_type = "Bearer",
        });
    }

    private static string Encode(string text) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(text)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}

/// <summary>One call the fake answered.</summary>
internal sealed record FakeProviderCall(string Method, string Path, string Query, IReadOnlyDictionary<string, string> Form, string Authorization);
