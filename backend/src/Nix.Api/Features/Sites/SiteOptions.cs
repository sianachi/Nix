using System.Collections.ObjectModel;
using System.Globalization;
using Microsoft.Extensions.Configuration;
using Nix.Domain.Sites;

namespace Nix.Features.Sites;

/// <summary>
/// Deployment configuration for sites (<c>Nix:Sites</c>). An empty <see cref="Domain"/> turns the
/// feature off: no site can be created and nothing is served.
/// </summary>
public sealed class SiteOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Sites";

    /// <summary>Gets or sets the dedicated registrable domain default hostnames live under.</summary>
    public string Domain { get; set; } = string.Empty;

    /// <summary>Gets or sets the object-store bucket holding builds, assets and host manifests.</summary>
    public string Bucket { get; set; } = string.Empty;

    /// <summary>Gets or sets <c>https</c>, or <c>http</c> for local development.</summary>
    public string PublicScheme { get; set; } = "https";

    /// <summary>Gets or sets the public port when it is not the scheme's default.</summary>
    public int? PublicPort { get; set; }

    /// <summary>Gets or sets how many finished builds a site keeps for rollback.</summary>
    public int BuildsRetained { get; set; } = 5;

    /// <summary>
    /// Gets or sets whether the sites domain is the app's own apex host, with sites one label below
    /// it (<c>nixsites.com</c> and <c>&lt;slug&gt;.nixsites.com</c>). Off by default; the app's
    /// cookies are then host-only (<c>__Host-</c>), and the apex and every infrastructure slug are
    /// never served as a site.
    /// </summary>
    public bool SharedAppDomain { get; set; }

    /// <summary>
    /// Gets the reserved slugs a workspace may still claim, each mapped to the one workspace that
    /// may: the deployment owner's own sites. Infrastructure slugs are never claimable.
    /// </summary>
    public Dictionary<string, Guid> ReservedSlugOwners { get; } = new(StringComparer.Ordinal);

    /// <summary>Gets or sets how many sites one tenant may have.</summary>
    public int MaximumSitesPerTenant { get; set; } = 20;

    /// <summary>Gets or sets the host the app is served from (from <c>Nix:Bff:PublicOrigin</c>), when known.</summary>
    public string? AppHost { get; set; }

    /// <summary>
    /// Gets or sets the hostname a custom hostname's CNAME should point at (for example a proxied
    /// name in front of the sites serving process). Shown to managers; apex domains rely on CNAME
    /// flattening. Null shows no routing record.
    /// </summary>
    public string? CustomHostnameTarget { get; set; }

    /// <summary>Gets or sets the DNS-over-HTTPS endpoint (JSON API) custom hostnames are checked through.</summary>
    public Uri DnsResolverUrl { get; set; } = new("https://cloudflare-dns.com/dns-query");

    /// <summary>Gets or sets whether a site's first publish (and first after an unpublish) waits for an operator.</summary>
    public bool RequireOperatorApproval { get; set; }

    /// <summary>
    /// Gets the principals who approve first publishes. Empty means the tenant administrators.
    /// </summary>
    public Collection<Guid> Operators { get; } = [];

    /// <summary>Gets the operator's Cloudflare automation (<c>Nix:Sites:Cloudflare</c>).</summary>
    public SiteCloudflareOptions Cloudflare { get; } = new();

    /// <summary>Gets whether sites are enabled on this deployment.</summary>
    public bool IsEnabled => Domain.Length > 0;

    /// <summary>Reads the section from <paramref name="configuration"/>.</summary>
    /// <param name="configuration">The host configuration.</param>
    /// <returns>The bound options, with the domain lowercased.</returns>
    public static SiteOptions Bind(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var options = new SiteOptions();
        configuration.GetSection(SectionName).Bind(options);
        options.Domain = SiteRules.NormalizeHost(options.Domain);
        foreach (var zone in options.Cloudflare.ManagedZones)
        {
            zone.Zone = SiteRules.NormalizeHost(zone.Zone);
        }
        if (Uri.TryCreate(configuration["Nix:Bff:PublicOrigin"], UriKind.Absolute, out var appOrigin))
        {
            options.AppHost = SiteRules.NormalizeHost(appOrigin.Host);
        }

        return options;
    }

    /// <summary>Whether <paramref name="hostname"/> is the app's own host.</summary>
    /// <param name="hostname">A normalized hostname.</param>
    /// <returns>True when it names the app.</returns>
    public bool IsAppHost(string hostname) => AppHost is { Length: > 0 } app && hostname == app;

    /// <summary>
    /// Whether a site in <paramref name="workspaceId"/> may take <paramref name="slug"/>: any slug
    /// that is not reserved, or a reserved one the configuration hands to that workspace.
    /// </summary>
    /// <param name="slug">A valid slug.</param>
    /// <param name="workspaceId">The workspace the site's root is in.</param>
    /// <returns>True when the slug may be claimed.</returns>
    public bool MayClaimSlug(string slug, Guid workspaceId) =>
        !SiteRules.IsInfrastructureSlug(slug)
        && (!SiteRules.IsReservedSlug(slug) || (ReservedSlugOwners.TryGetValue(slug, out var owner) && owner == workspaceId));

    /// <summary>The default hostname of a site: its slug under the sites domain.</summary>
    /// <param name="slug">A valid slug.</param>
    /// <returns>The hostname.</returns>
    public string DefaultHostname(string slug) => slug + "." + Domain;

    /// <summary>The public URL of a hostname's root.</summary>
    /// <param name="hostname">A hostname.</param>
    /// <returns>An absolute URL ending in a slash.</returns>
    public Uri PublicUrl(string hostname)
    {
        var port = PublicPort is { } value && !IsDefaultPort(value) ? ":" + value.ToString(CultureInfo.InvariantCulture) : string.Empty;
        return new Uri($"{PublicScheme}://{hostname}{port}/", UriKind.Absolute);
    }

    /// <summary>
    /// Refuses a configuration that would serve user content from a domain the app's own cookies
    /// reach, or that is not usable at all. Called at startup, before the host accepts a request.
    /// </summary>
    /// <param name="appHost">The host the app is served from, when known.</param>
    /// <param name="isDevelopment">Whether the host runs in Development, which exempts <c>*.localhost</c>.</param>
    /// <exception cref="InvalidOperationException">The configuration is unusable or unsafe.</exception>
    public void AssertValid(string? appHost, bool isDevelopment)
    {
        if (!IsEnabled)
        {
            return;
        }

        if (!SiteRules.IsHostname(Domain))
        {
            throw new InvalidOperationException("Nix:Sites:Domain must be a lowercase DNS name such as 'sites.example.net'.");
        }

        if (SiteDomainPolicy.Check(Domain, appHost, isDevelopment, SharedAppDomain) is { } refusal)
        {
            throw new InvalidOperationException("Nix:Sites:Domain is unsafe: " + refusal);
        }

        if (Bucket.Length is < 3 or > 63 || Bucket.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '.')))
        {
            throw new InvalidOperationException("Nix:Sites:Bucket must name the sites bucket (3 to 63 letters, digits, '-' or '.').");
        }

        if (PublicScheme is not ("https" or "http") || (PublicScheme == "http" && !isDevelopment && !Domain.EndsWith(".localhost", StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("Nix:Sites:PublicScheme must be https outside local development.");
        }

        if (PublicPort is < 1 or > 65535 || BuildsRetained is < 1 or > 50 || MaximumSitesPerTenant is < 1 or > 10_000)
        {
            throw new InvalidOperationException("Nix:Sites contains a value outside its supported bounds.");
        }

        if (CustomHostnameTarget is { Length: > 0 } target && !SiteRules.IsHostname(SiteRules.NormalizeHost(target)))
        {
            throw new InvalidOperationException("Nix:Sites:CustomHostnameTarget must be a hostname.");
        }

        if (DnsResolverUrl.Scheme != Uri.UriSchemeHttps)
        {
            throw new InvalidOperationException("Nix:Sites:DnsResolverUrl must be an https URL.");
        }

        Cloudflare.AssertValid(Domain, appHost);
    }

    private bool IsDefaultPort(int port) => (PublicScheme == "https" && port == 443) || (PublicScheme == "http" && port == 80);
}

/// <summary>
/// The check that keeps a site's content off the app's registrable domain, unless the operator
/// opted into the one shared layout (app at the apex, sites one label below). Without a public
/// suffix list this is a heuristic, deliberately on the strict side: it can refuse a legitimate
/// pair under a multi-part suffix, and the operator then picks a clearly separate domain.
/// </summary>
public static class SiteDomainPolicy
{
    /// <summary>Checks <paramref name="sitesDomain"/> against the app's host.</summary>
    /// <param name="sitesDomain">The sites domain.</param>
    /// <param name="appHost">The app host, or null when it is not configured (nothing to compare).</param>
    /// <param name="isDevelopment">Whether <c>*.localhost</c> is exempt.</param>
    /// <param name="sharedAppDomain">
    /// Whether the operator accepted serving sites one label below the app's own host
    /// (<c>Nix:Sites:SharedAppDomain</c>). Only the exact pair is accepted; every other overlap is
    /// still refused.
    /// </param>
    /// <returns>A sentence saying why the pair is refused, or null when it is acceptable.</returns>
    public static string? Check(string sitesDomain, string? appHost, bool isDevelopment, bool sharedAppDomain = false)
    {
        ArgumentNullException.ThrowIfNull(sitesDomain);
        var sites = Normalize(sitesDomain);
        if (string.IsNullOrWhiteSpace(appHost))
        {
            return null;
        }

        var app = Normalize(appHost);
        if (sites == app)
        {
            return sharedAppDomain ? null : "it equals the app host; set Nix:Sites:SharedAppDomain to serve sites below the app's apex.";
        }

        if (isDevelopment && sites.EndsWith(".localhost", StringComparison.Ordinal))
        {
            return null;
        }

        if (sites.EndsWith("." + app, StringComparison.Ordinal) || app.EndsWith("." + sites, StringComparison.Ordinal))
        {
            return "one of the domains is a subdomain of the other.";
        }

        return LastTwoLabels(sites) == LastTwoLabels(app)
            ? "both share the same registrable domain, so the app's cookies would reach site content."
            : null;
    }

    private static string Normalize(string host) => SiteRules.NormalizeHost(host);

    private static string LastTwoLabels(string host)
    {
        var labels = host.Split('.');
        return string.Join('.', labels.Length <= 2 ? labels : labels[^2..]);
    }
}
