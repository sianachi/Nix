using Microsoft.Extensions.Options;
using Nix.Authentication;

namespace Nix.Features.CalendarSync;

/// <summary>Deployment configuration for calendar sync, bound to <c>Nix:Calendar</c> (ADR-0052).</summary>
public sealed class CalendarSyncOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Calendar";

    /// <summary>The public same-origin Nix URL the provider redirects back to; defaults to the BFF's.</summary>
    public string PublicOrigin { get; set; } = string.Empty;

    /// <summary>Google OAuth client and endpoint origins.</summary>
    public CalendarProviderOptions Google { get; set; } = new()
    {
        AuthorizeOrigin = "https://accounts.google.com",
        TokenOrigin = "https://oauth2.googleapis.com",
        ApiOrigin = "https://www.googleapis.com",
    };

    /// <summary>Microsoft Entra OAuth client and endpoint origins.</summary>
    public CalendarProviderOptions Microsoft { get; set; } = new()
    {
        AuthorizeOrigin = "https://login.microsoftonline.com",
        TokenOrigin = "https://login.microsoftonline.com",
        ApiOrigin = "https://graph.microsoft.com",
    };
}

/// <summary>One provider's OAuth client and the fixed origins Core may call.</summary>
public sealed class CalendarProviderOptions
{
    /// <summary>The OAuth client id.</summary>
    public string ClientId { get; set; } = string.Empty;

    /// <summary>The OAuth client secret. Never logged, never leaves Core.</summary>
    public string ClientSecret { get; set; } = string.Empty;

    /// <summary>The Entra tenant segment (Microsoft only).</summary>
    public string Tenant { get; set; } = "common";

    /// <summary>The origin of the browser authorization endpoint.</summary>
    public string AuthorizeOrigin { get; set; } = string.Empty;

    /// <summary>The origin of the token (and, for Google, revoke) endpoint.</summary>
    public string TokenOrigin { get; set; } = string.Empty;

    /// <summary>The origin of the read-only calendar listing API.</summary>
    public string ApiOrigin { get; set; } = string.Empty;
}

/// <summary>One provider's validated configuration.</summary>
/// <param name="Provider">The provider name.</param>
/// <param name="ClientId">The OAuth client id.</param>
/// <param name="ClientSecret">The OAuth client secret.</param>
/// <param name="Tenant">The Entra tenant segment.</param>
/// <param name="AuthorizeOrigin">The authorization endpoint's origin.</param>
/// <param name="TokenOrigin">The token endpoint's origin.</param>
/// <param name="ApiOrigin">The listing API's origin.</param>
public sealed record CalendarProviderEndpoints(
    string Provider,
    string ClientId,
    string ClientSecret,
    string Tenant,
    Uri AuthorizeOrigin,
    Uri TokenOrigin,
    Uri ApiOrigin);

/// <summary>
/// Which providers this deployment can connect, resolved once from configuration: a provider is
/// available only with a client id and secret, valid origins, a public origin to redirect back to,
/// and persisted Data Protection keys (outside Development and Testing).
/// </summary>
/// <remarks>
/// [SEC] Origins must be <c>https</c> origins with no path; plain <c>http</c> is accepted only for
/// a loopback host in Development or Testing, where tests aim the clients at a fake server. The
/// refresh tokens are Data Protection-protected, so keys that do not survive a restart would
/// silently turn every connection into a reconnect.
/// </remarks>
public sealed class CalendarProviderSettings
{
    /// <summary>The providers Core knows, in display order.</summary>
    public static readonly IReadOnlyList<string> Providers = ["google", "microsoft"];

    private readonly Dictionary<string, CalendarProviderEndpoints> _available = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _disabled = new(StringComparer.Ordinal);

    /// <summary>Resolves the settings.</summary>
    public CalendarProviderSettings(
        IOptions<CalendarSyncOptions> options,
        IOptions<BrowserAuthOptions> browser,
        IConfiguration configuration,
        IHostEnvironment? environment = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(browser);
        ArgumentNullException.ThrowIfNull(configuration);

        // No host environment (a bare composition root) reads as production: strict.
        var relaxed = environment is not null && (environment.IsDevelopment() || environment.IsEnvironment("Testing"));
        var value = options.Value;
        var publicOrigin = string.IsNullOrWhiteSpace(value.PublicOrigin) ? browser.Value.PublicOrigin : value.PublicOrigin;
        PublicOrigin = TryOrigin(publicOrigin, relaxed, out var origin) ? origin : null;
        var keysPersisted = !string.IsNullOrWhiteSpace(configuration["Nix:Bff:DataProtectionKeysPath"]);

        foreach (var (name, provider) in new[] { ("google", value.Google), ("microsoft", value.Microsoft) })
        {
            if (string.IsNullOrWhiteSpace(provider.ClientId) || string.IsNullOrWhiteSpace(provider.ClientSecret))
            {
                _disabled[name] = "not_configured";
                continue;
            }

            if (PublicOrigin is null)
            {
                _disabled[name] = "public_origin_invalid";
                continue;
            }

            if (!keysPersisted && !relaxed)
            {
                _disabled[name] = "data_protection_keys_not_persisted";
                continue;
            }

            if (!TryOrigin(provider.AuthorizeOrigin, relaxed, out var authorize)
                || !TryOrigin(provider.TokenOrigin, relaxed, out var token)
                || !TryOrigin(provider.ApiOrigin, relaxed, out var api)
                || (name == "microsoft" && !IsTenantSegment(provider.Tenant)))
            {
                _disabled[name] = "origin_invalid";
                continue;
            }

            _available[name] = new CalendarProviderEndpoints(
                name, provider.ClientId, provider.ClientSecret, provider.Tenant, authorize, token, api);
        }
    }

    /// <summary>Gets the validated public origin, or <see langword="null"/> when none is usable.</summary>
    public Uri? PublicOrigin { get; }

    /// <summary>Whether <paramref name="provider"/> can be connected.</summary>
    public bool IsAvailable(string provider) => _available.ContainsKey(provider);

    /// <summary>The provider's validated endpoints, or <see langword="null"/> when unavailable.</summary>
    public CalendarProviderEndpoints? For(string provider) => _available.GetValueOrDefault(provider);

    /// <summary>Providers that are configured but disabled, with a short reason, for the startup log.</summary>
    public IReadOnlyDictionary<string, string> Disabled => _disabled;

    /// <summary>The exact redirect URI registered at the provider.</summary>
    public Uri RedirectUri(string provider) =>
        new(PublicOrigin ?? throw new InvalidOperationException("No public origin is configured."), $"/auth/calendar/callback/{provider}");

    /// <summary>Whether cookies must carry Secure.</summary>
    public bool SecureCookies => PublicOrigin?.Scheme == Uri.UriSchemeHttps;

    private static bool IsTenantSegment(string tenant) =>
        tenant is { Length: > 0 and <= 64 } && tenant.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '.');

    private static bool TryOrigin(string? value, bool relaxed, out Uri origin)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            && string.IsNullOrEmpty(parsed.UserInfo)
            && string.IsNullOrEmpty(parsed.Query)
            && string.IsNullOrEmpty(parsed.Fragment)
            && parsed.AbsolutePath == "/"
            && (parsed.Scheme == Uri.UriSchemeHttps || (relaxed && parsed.Scheme == Uri.UriSchemeHttp && parsed.IsLoopback)))
        {
            origin = parsed;
            return true;
        }

        origin = null!;
        return false;
    }
}
