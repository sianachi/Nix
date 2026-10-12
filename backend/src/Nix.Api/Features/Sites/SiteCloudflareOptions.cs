using System.Collections.ObjectModel;
using Nix.Domain.Sites;

namespace Nix.Features.Sites;

/// <summary>
/// Operator-level Cloudflare automation for custom hostnames (<c>Nix:Sites:Cloudflare</c>). Off
/// unless a token and at least one managed zone are configured. The token is an operator secret:
/// it comes from configuration only, is held by Core alone and is never logged or returned.
/// </summary>
public sealed class SiteCloudflareOptions
{
    /// <summary>Gets or sets the API token (Zone:Read, DNS:Edit, and Cloudflare Tunnel:Edit when a tunnel is set).</summary>
    public string ApiToken { get; set; } = string.Empty;

    /// <summary>Gets or sets the account the zones and the tunnel belong to.</summary>
    public string AccountId { get; set; } = string.Empty;

    /// <summary>Gets or sets the tunnel custom hostnames are routed through (home production), or null for proxied DNS only.</summary>
    public string? TunnelId { get; set; }

    /// <summary>Gets or sets the origin a tunnel public hostname points at: the sites serving process.</summary>
    public string TunnelService { get; set; } = "http://sites-serve:8400";

    /// <summary>Gets or sets the CNAME target written for a managed hostname when no tunnel is set.</summary>
    public string? DefaultTarget { get; set; }

    /// <summary>
    /// Gets the zones Nix may write records in, each with the one workspace whose sites may use it.
    /// The token can edit every zone in its account, so a zone is never open to every workspace:
    /// any other workspace's hostname in that zone falls back to the manual records it cannot create.
    /// </summary>
    public Collection<SiteManagedZone> ManagedZones { get; } = [];

    /// <summary>
    /// Gets or sets the id of the sites domain's own zone, where Nix writes this instance's default
    /// hostnames. Used only with <c>Nix:Sites:DefaultHostLabelSuffix</c> (an instance sharing the
    /// sites domain without a wildcard), only for names of that suffix, and never for a custom
    /// hostname: the zone is deliberately not a managed zone.
    /// </summary>
    public string? DefaultHostnameZoneId { get; set; }

    /// <summary>Gets whether automation is configured at all.</summary>
    public bool IsEnabled => ApiToken.Length > 0 && (ManagedZones.Count > 0 || DefaultHostnameZoneId is { Length: > 0 });

    /// <summary>
    /// The managed zone a workspace may automate <paramref name="hostname"/> in, if any. The zone
    /// apex itself is never automated: it usually carries the owner's own records, so it takes the
    /// manual path like any unmanaged name.
    /// </summary>
    /// <param name="hostname">A normalized hostname.</param>
    /// <param name="workspaceId">The site's workspace.</param>
    /// <returns>The most specific matching zone, or null.</returns>
    public SiteManagedZone? ZoneFor(string hostname, Guid workspaceId)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        return !IsEnabled
            ? null
            : ManagedZones
                .Where(zone => zone.WorkspaceId == workspaceId && hostname.EndsWith("." + zone.Zone, StringComparison.Ordinal))
                .MaxBy(zone => zone.Zone.Length);
    }

    /// <summary>
    /// Refuses an automation configuration that cannot work, or that would hand one workspace names
    /// the deployment itself lives under: a managed zone may not equal, contain or sit under the
    /// sites domain or the app's registrable domain (a manager could otherwise publish over
    /// another site's default hostname or next to the app's own cookies).
    /// </summary>
    /// <param name="sitesDomain">The sites domain.</param>
    /// <param name="appHost">The app host, when known.</param>
    /// <param name="defaultLabelSuffix">The instance's default hostname label suffix, empty when it has none.</param>
    /// <exception cref="InvalidOperationException">A required value is missing, malformed or unsafe.</exception>
    public void AssertValid(string sitesDomain, string? appHost, string defaultLabelSuffix = "")
    {
        ArgumentNullException.ThrowIfNull(defaultLabelSuffix);
        if (DefaultHostnameZoneId is { Length: > 0 } zoneId
            && (ApiToken.Length == 0 || defaultLabelSuffix.Length == 0
                || zoneId.Length != 32 || !zoneId.All(static c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'))))
        {
            throw new InvalidOperationException(
                "Nix:Sites:Cloudflare:DefaultHostnameZoneId needs ApiToken and Nix:Sites:DefaultHostLabelSuffix, and must be a 32-character zone id.");
        }

        if (ApiToken.Length == 0)
        {
            return;
        }

        foreach (var zone in ManagedZones)
        {
            if (!SiteRules.IsHostname(zone.Zone) || zone.WorkspaceId == Guid.Empty)
            {
                throw new InvalidOperationException("Each Nix:Sites:Cloudflare:ManagedZones entry needs a Zone such as 'example.com' and a WorkspaceId.");
            }

            string[] reserved = appHost is { Length: > 0 } app ? [sitesDomain, RegistrableDomain(app)] : [sitesDomain];
            if (reserved.Any(name => name.Length > 0 && Overlaps(zone.Zone, name)))
            {
                throw new InvalidOperationException(
                    $"Nix:Sites:Cloudflare:ManagedZones may not include '{zone.Zone}': it overlaps the sites domain or the app's domain.");
            }
        }

        if (TunnelId is { Length: > 0 }
            && (AccountId.Length == 0 || !Uri.TryCreate(TunnelService, UriKind.Absolute, out var service) || service.Scheme is not ("http" or "https")))
        {
            throw new InvalidOperationException("Nix:Sites:Cloudflare:TunnelId needs AccountId and an http(s) TunnelService.");
        }

        if (TunnelId is not { Length: > 0 } && DefaultTarget is { Length: > 0 } target && !SiteRules.IsHostname(SiteRules.NormalizeHost(target)))
        {
            throw new InvalidOperationException("Nix:Sites:Cloudflare:DefaultTarget must be a hostname.");
        }
    }

    /// <summary>Whether two DNS names are equal or one lies under the other.</summary>
    private static bool Overlaps(string first, string second) =>
        first == second
        || first.EndsWith("." + second, StringComparison.Ordinal)
        || second.EndsWith("." + first, StringComparison.Ordinal);

    // The same last-two-labels heuristic SiteDomainPolicy uses; strict under multi-part suffixes.
    private static string RegistrableDomain(string host)
    {
        var labels = SiteRules.NormalizeHost(host).Split('.');
        return string.Join('.', labels.Length <= 2 ? labels : labels[^2..]);
    }
}

/// <summary>A Cloudflare zone Nix may write records in, and the workspace allowed to use it.</summary>
public sealed class SiteManagedZone
{
    /// <summary>Gets or sets the zone name, such as <c>example.com</c>.</summary>
    public string Zone { get; set; } = string.Empty;

    /// <summary>Gets or sets the one workspace whose sites may have hostnames automated in the zone.</summary>
    public Guid WorkspaceId { get; set; }
}
