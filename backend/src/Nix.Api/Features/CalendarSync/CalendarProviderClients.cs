using System.Buffers.Text;
using System.Net;
using System.Text;
using System.Text.Json;
using Nix.Abstractions.Calendar;
using Nix.Authentication;

namespace Nix.Features.CalendarSync;

/// <summary>Resolves the provider client for a connection's provider.</summary>
public sealed class CalendarProviderClients(IEnumerable<ICalendarProviderClient> clients)
{
    /// <summary>The redirect-disabled, bounded client every provider call goes through.</summary>
    public const string HttpClientName = "nix-calendar-provider";

    private readonly Dictionary<string, ICalendarProviderClient> _clients =
        clients.ToDictionary(client => client.Provider, StringComparer.Ordinal);

    /// <summary>The client for <paramref name="provider"/>, or <see langword="null"/>.</summary>
    public ICalendarProviderClient? For(string provider) => _clients.GetValueOrDefault(provider);
}

/// <summary>
/// The transport shared by both provider clients (ADR-0052 Amendment 1 A3) [SEC]: fixed,
/// validated origins only; no redirects; a ten-second deadline per call; bounded bodies; and no
/// token, code, secret or response body ever logged - only the provider's <c>error</c> code, cut
/// to 64 characters.
/// </summary>
public abstract class CalendarProviderClientBase : ICalendarProviderClient
{
    private const int MaximumTokenResponseBytes = 64 * 1024;
    private const int MaximumListResponseBytes = 256 * 1024;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(10);

    private readonly IHttpClientFactory _clients;
    private readonly CalendarProviderSettings _settings;
    private readonly ILogger _logger;

    /// <summary>Initializes the shared transport.</summary>
    protected CalendarProviderClientBase(IHttpClientFactory clients, CalendarProviderSettings settings, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(clients);
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(logger);
        _clients = clients;
        _settings = settings;
        _logger = logger;
    }

    /// <inheritdoc />
    public abstract string Provider { get; }

    /// <summary>Gets this provider's validated endpoints.</summary>
    /// <exception cref="CalendarProviderUnavailableException">The provider is not configured.</exception>
    protected CalendarProviderEndpoints Endpoints() =>
        _settings.For(Provider) ?? throw new CalendarProviderUnavailableException("The calendar provider is not configured.");

    /// <summary>The token endpoint.</summary>
    protected abstract Uri TokenEndpoint(CalendarProviderEndpoints endpoints);

    /// <summary>The scope parameter of a code redemption, if the provider wants one.</summary>
    protected virtual string? RedemptionScope => null;

    /// <inheritdoc />
    public async Task<CalendarTokenGrant> ExchangeCodeAsync(string code, string verifier, Uri redirectUri, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(redirectUri);
        var endpoints = Endpoints();
        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["client_id"] = endpoints.ClientId,
            ["client_secret"] = endpoints.ClientSecret,
            ["redirect_uri"] = redirectUri.AbsoluteUri,
            ["code_verifier"] = verifier,
        };
        if (RedemptionScope is { } scope)
        {
            form["scope"] = scope;
        }

        using var document = await PostTokenAsync(form, refresh: false, cancellationToken).ConfigureAwait(false);
        var root = document.RootElement;
        var access = RequiredString(root, "access_token");
        var refresh = RequiredString(root, "refresh_token");
        var idToken = RequiredString(root, "id_token");
        var claims = ReadIdTokenClaims(idToken);
        var (subject, email) = Identity(claims);
        if (string.IsNullOrWhiteSpace(subject) || subject.Length > 255)
        {
            throw new CalendarProviderUnavailableException("The calendar provider returned no account identity.");
        }

        var scopes = root.TryGetProperty("scope", out var scopeValue) && scopeValue.ValueKind == JsonValueKind.String
            ? scopeValue.GetString() ?? string.Empty
            : string.Empty;
        return new CalendarTokenGrant(
            refresh,
            access,
            ExpiresIn(root),
            subject,
            CalendarSyncRulesText.Bound(email ?? string.Empty, 320),
            CalendarSyncRulesText.Bound(scopes, 1000));
    }

    /// <inheritdoc />
    public async Task<CalendarAccessGrant> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var endpoints = Endpoints();
        using var document = await PostTokenAsync(
            new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
                ["client_id"] = endpoints.ClientId,
                ["client_secret"] = endpoints.ClientSecret,
            },
            refresh: true,
            cancellationToken).ConfigureAwait(false);
        var root = document.RootElement;
        var rotated = root.TryGetProperty("refresh_token", out var rotation) && rotation.ValueKind == JsonValueKind.String
            ? rotation.GetString()
            : null;
        return new CalendarAccessGrant(RequiredString(root, "access_token"), ExpiresIn(root), string.IsNullOrEmpty(rotated) ? null : rotated);
    }

    /// <inheritdoc />
    public abstract Task RevokeAsync(string refreshToken, CancellationToken cancellationToken);

    /// <inheritdoc />
    public abstract Task<IReadOnlyList<ExternalCalendar>> ListCalendarsAsync(string accessToken, CancellationToken cancellationToken);

    /// <summary>The account identity from the id_token claims.</summary>
    protected abstract (string? Subject, string? Email) Identity(JsonElement claims);

    /// <summary>GETs a listing and parses it, bounded.</summary>
    protected async Task<JsonDocument> GetListingAsync(Uri uri, string accessToken, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
        return await SendAsync(request, MaximumListResponseBytes, refresh: false, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>POSTs a form and ignores the answer beyond its status; used for Google's revoke.</summary>
    protected async Task PostFormBestEffortAsync(Uri uri, IReadOnlyDictionary<string, string> form, CancellationToken cancellationToken)
    {
        using var content = new FormUrlEncodedContent(form);
        using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = content };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(Deadline);
        try
        {
            using var client = _clients.CreateClient(CalendarProviderClients.HttpClientName);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                CalendarProviderLog.RevokeRefused(_logger, Provider, (int)response.StatusCode);
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or OperationCanceledException)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                throw;
            }

            CalendarProviderLog.RevokeUnreachable(_logger, Provider);
        }
    }

    private async Task<JsonDocument> PostTokenAsync(Dictionary<string, string> form, bool refresh, CancellationToken cancellationToken)
    {
        using var content = new FormUrlEncodedContent(form);
        using var request = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint(Endpoints())) { Content = content };
        return await SendAsync(request, MaximumTokenResponseBytes, refresh, cancellationToken).ConfigureAwait(false);
    }

    private async Task<JsonDocument> SendAsync(HttpRequestMessage request, int maximumBytes, bool refresh, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(Deadline);
        try
        {
            using var client = _clients.CreateClient(CalendarProviderClients.HttpClientName);
            using var response = await client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token)
                .ConfigureAwait(false);
            var bytes = await BoundedHttpContent.ReadAsync(response.Content, maximumBytes, deadline.Token).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                return JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
            }

            var error = ErrorCode(bytes);
            CalendarProviderLog.Refused(_logger, Provider, (int)response.StatusCode, error);

            // A refresh the provider refuses as a client error is a dead grant: invalid_grant,
            // unauthorized_client, or any 400/401. Anything else is the provider being unwell.
            if (refresh && response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
            {
                throw new CalendarReauthRequiredException("The calendar provider refused the stored grant.");
            }

            throw new CalendarProviderUnavailableException("The calendar provider refused the request.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            CalendarProviderLog.TimedOut(_logger, Provider);
            throw new CalendarProviderUnavailableException("The calendar provider did not answer in time.");
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or InvalidDataException or JsonException)
        {
            CalendarProviderLog.Unreachable(_logger, Provider, exception.GetType().Name);
            throw new CalendarProviderUnavailableException("The calendar provider could not be reached.", exception);
        }
    }

    /// <summary>Reads a required string member.</summary>
    protected static string RequiredString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var property)
        && property.ValueKind == JsonValueKind.String
        && property.GetString() is { Length: > 0 } value
            ? value
            : throw new CalendarProviderUnavailableException("The calendar provider response was incomplete.");

    /// <summary>Reads an optional string member.</summary>
    protected static string? OptionalString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;

    /// <summary>Reads an optional boolean member.</summary>
    protected static bool OptionalBool(JsonElement element, string name) =>
        element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.True;

    private static TimeSpan ExpiresIn(JsonElement root)
    {
        var seconds = root.TryGetProperty("expires_in", out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
            ? parsed
            : root.TryGetProperty("expires_in", out var text) && text.ValueKind == JsonValueKind.String
                && int.TryParse(text.GetString(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var fromText)
                ? fromText
                : 3600;
        return TimeSpan.FromSeconds(Math.Clamp(seconds, 60, 86_400));
    }

    /// <summary>
    /// Decodes an id_token's claims without verifying its signature: it arrived over TLS straight
    /// from the token endpoint (OIDC Core 3.1.3.7), and is read for the account identity only.
    /// </summary>
    private static JsonElement ReadIdTokenClaims(string idToken)
    {
        var parts = idToken.Split('.');
        if (parts.Length != 3 || parts[1].Length is 0 or > 16 * 1024)
        {
            throw new CalendarProviderUnavailableException("The calendar provider returned an unreadable id_token.");
        }

        try
        {
            var payload = Base64Url.DecodeFromChars(parts[1]);
            using var document = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 8 });
            return document.RootElement.Clone();
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            throw new CalendarProviderUnavailableException("The calendar provider returned an unreadable id_token.", exception);
        }
    }

    private static string ErrorCode(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 8 });
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("error", out var error))
            {
                var text = error.ValueKind == JsonValueKind.String
                    ? error.GetString()
                    : error.ValueKind == JsonValueKind.Object ? OptionalString(error, "code") ?? OptionalString(error, "status") : null;
                if (!string.IsNullOrEmpty(text))
                {
                    var cleaned = new string([.. text.Where(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.')]);
                    return cleaned.Length > 64 ? cleaned[..64] : cleaned;
                }
            }
        }
        catch (JsonException)
        {
        }

        return "none";
    }
}

/// <summary>Google Calendar's token, revoke and calendar-list endpoints.</summary>
public sealed class GoogleCalendarProviderClient(IHttpClientFactory clients, CalendarProviderSettings settings, ILogger<GoogleCalendarProviderClient> logger)
    : CalendarProviderClientBase(clients, settings, logger)
{
    /// <inheritdoc />
    public override string Provider => "google";

    /// <inheritdoc />
    protected override Uri TokenEndpoint(CalendarProviderEndpoints endpoints) => new(endpoints.TokenOrigin, "/token");

    /// <inheritdoc />
    public override Task RevokeAsync(string refreshToken, CancellationToken cancellationToken) =>
        PostFormBestEffortAsync(
            new Uri(Endpoints().TokenOrigin, "/revoke"),
            new Dictionary<string, string> { ["token"] = refreshToken },
            cancellationToken);

    /// <inheritdoc />
    public override async Task<IReadOnlyList<ExternalCalendar>> ListCalendarsAsync(string accessToken, CancellationToken cancellationToken)
    {
        using var document = await GetListingAsync(
            new Uri(Endpoints().ApiOrigin, "/calendar/v3/users/me/calendarList?maxResults=250"),
            accessToken,
            cancellationToken).ConfigureAwait(false);
        var calendars = new List<ExternalCalendar>();
        if (document.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in items.EnumerateArray().Take(250))
            {
                var id = OptionalString(entry, "id");
                if (string.IsNullOrEmpty(id) || id.Length > 500)
                {
                    continue;
                }

                var role = OptionalString(entry, "accessRole");
                var name = OptionalString(entry, "summaryOverride") ?? OptionalString(entry, "summary") ?? id;
                calendars.Add(new ExternalCalendar(
                    id,
                    CalendarSyncRulesText.Bound(name, 200),
                    OptionalBool(entry, "primary"),
                    role is not ("owner" or "writer")));
            }
        }

        return calendars;
    }

    /// <inheritdoc />
    protected override (string? Subject, string? Email) Identity(JsonElement claims) =>
        (OptionalString(claims, "sub"), OptionalString(claims, "email"));
}

/// <summary>Microsoft identity platform token endpoint and Graph calendar listing.</summary>
/// <remarks>Microsoft has no per-grant revoke endpoint; disconnecting only forgets the grant.</remarks>
public sealed class MicrosoftCalendarProviderClient(IHttpClientFactory clients, CalendarProviderSettings settings, ILogger<MicrosoftCalendarProviderClient> logger)
    : CalendarProviderClientBase(clients, settings, logger)
{
    /// <summary>The delegated scopes requested, including <c>openid email</c> for the id_token (Amendment 1 A4).</summary>
    public const string Scopes = "openid email offline_access Calendars.ReadWrite";

    /// <inheritdoc />
    public override string Provider => "microsoft";

    /// <inheritdoc />
    protected override Uri TokenEndpoint(CalendarProviderEndpoints endpoints) => new(endpoints.TokenOrigin, $"/{endpoints.Tenant}/oauth2/v2.0/token");

    /// <inheritdoc />
    protected override string? RedemptionScope => Scopes;

    /// <inheritdoc />
    public override Task RevokeAsync(string refreshToken, CancellationToken cancellationToken) => Task.CompletedTask;

    /// <inheritdoc />
    public override async Task<IReadOnlyList<ExternalCalendar>> ListCalendarsAsync(string accessToken, CancellationToken cancellationToken)
    {
        using var document = await GetListingAsync(
            new Uri(Endpoints().ApiOrigin, "/v1.0/me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar"),
            accessToken,
            cancellationToken).ConfigureAwait(false);
        var calendars = new List<ExternalCalendar>();
        if (document.RootElement.TryGetProperty("value", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in items.EnumerateArray().Take(100))
            {
                var id = OptionalString(entry, "id");
                if (string.IsNullOrEmpty(id) || id.Length > 500)
                {
                    continue;
                }

                calendars.Add(new ExternalCalendar(
                    id,
                    CalendarSyncRulesText.Bound(OptionalString(entry, "name") ?? id, 200),
                    OptionalBool(entry, "isDefaultCalendar"),
                    !OptionalBool(entry, "canEdit")));
            }
        }

        return calendars;
    }

    /// <inheritdoc />
    protected override (string? Subject, string? Email) Identity(JsonElement claims)
    {
        var tenant = OptionalString(claims, "tid");
        var objectId = OptionalString(claims, "oid");
        var subject = string.IsNullOrEmpty(tenant) || string.IsNullOrEmpty(objectId) ? null : $"{tenant}:{objectId}";
        return (subject, OptionalString(claims, "email") ?? OptionalString(claims, "preferred_username"));
    }
}

/// <summary>Text bounds shared by the provider clients.</summary>
internal static class CalendarSyncRulesText
{
    internal static string Bound(string value, int maximum) => Nix.Domain.Calendar.CalendarSyncRules.Bound(
        Nix.Domain.Calendar.CalendarSyncRules.Sanitize(value).Replace('\n', ' ').Replace('\t', ' '), maximum);
}

internal static partial class CalendarProviderLog
{
    [LoggerMessage(5400, LogLevel.Warning, "Calendar provider {Provider} refused a request with status {Status} and error {Error}")]
    internal static partial void Refused(ILogger logger, string provider, int status, string error);

    [LoggerMessage(5401, LogLevel.Warning, "Calendar provider {Provider} did not answer within the deadline")]
    internal static partial void TimedOut(ILogger logger, string provider);

    [LoggerMessage(5402, LogLevel.Warning, "Calendar provider {Provider} could not be reached ({ErrorClass})")]
    internal static partial void Unreachable(ILogger logger, string provider, string errorClass);

    [LoggerMessage(5403, LogLevel.Information, "Calendar provider {Provider} refused a revoke with status {Status}")]
    internal static partial void RevokeRefused(ILogger logger, string provider, int status);

    [LoggerMessage(5404, LogLevel.Information, "Calendar provider {Provider} could not be reached to revoke a grant")]
    internal static partial void RevokeUnreachable(ILogger logger, string provider);

    [LoggerMessage(5405, LogLevel.Warning, "Calendar provider {Provider} is disabled: {Reason}")]
    internal static partial void ProviderDisabled(ILogger logger, string provider, string reason);
}
