namespace Nix.Authentication;

/// <summary>Deployment-owned OIDC client and browser-session policy.</summary>
public sealed class BrowserAuthOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Bff";

    /// <summary>The bounded, redirect-disabled client used for OIDC discovery and token exchange.</summary>
    public const string HttpClientName = "nix-browser-oidc";

    /// <summary>The public issuer used for interactive login.</summary>
    public string Authority { get; init; } = string.Empty;

    /// <summary>The public OIDC application's client identifier.</summary>
    public string ClientId { get; init; } = string.Empty;

    /// <summary>The public same-origin Nix URL, without a path.</summary>
    public string PublicOrigin { get; init; } = string.Empty;

    /// <summary>How long a local browser session stands before a new OIDC login.</summary>
    public int SessionHours { get; init; } = 8;

    /// <summary>Whether all values required to start a login are present and safe.</summary>
    public bool IsConfigured => TryAuthority(out _) && TryPublicOrigin(out _) && !string.IsNullOrWhiteSpace(ClientId);

    /// <summary>The exact callback registered at the provider.</summary>
    public Uri CallbackUri => new(new Uri(PublicOrigin, UriKind.Absolute), "/auth/callback");

    /// <summary>Parses the configured authority.</summary>
    public bool TryAuthority(out Uri authority) => TryOrigin(Authority, out authority);

    /// <summary>Parses the public application origin.</summary>
    public bool TryPublicOrigin(out Uri origin) => TryOrigin(PublicOrigin, out origin);

    private static bool TryOrigin(string value, out Uri origin)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            && string.IsNullOrEmpty(parsed.UserInfo)
            && string.IsNullOrEmpty(parsed.Query)
            && string.IsNullOrEmpty(parsed.Fragment)
            && parsed.AbsolutePath == "/"
            && (parsed.Scheme == Uri.UriSchemeHttps
                || (parsed.Scheme == Uri.UriSchemeHttp && parsed.IsLoopback)))
        {
            origin = parsed;
            return true;
        }

        origin = null!;
        return false;
    }
}
