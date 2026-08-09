using System.Globalization;
using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

// Microsoft.AspNetCore.HttpOverrides carries its own obsolete IPNetwork; the framework one is what
// KnownIPNetworks takes, and the alias says which is meant without qualifying every use.
using IPNetwork = System.Net.IPNetwork;

namespace Nix.Http;

/// <summary>
/// Configures which hops are allowed to tell this process who the client is.
/// </summary>
/// <remarks>
/// <para>
/// Core runs behind a reverse proxy in every deployed environment, so without
/// <c>UseForwardedHeaders</c> every request arrives from the proxy's own address and both baseline
/// limiters collapse into one global bucket: the writes limit becomes a deployment-wide budget, and
/// the failed-authentication throttle - which is checked before validation - turns ten bad tokens
/// from anyone into a 429 for everyone.
/// </para>
/// <para>
/// <b>Why the allowlist is not optional.</b> Trusting <c>X-Forwarded-For</c> from any peer is worse
/// than not reading it at all. The header is client-supplied, so an unrestricted trust hands the
/// partition key to the attacker: a hostile client can spend a fresh address per request to evade
/// its own limit, and can name a victim's address to burn through that victim's window instead. The
/// header is therefore honoured only when the immediate peer is a listed proxy, and
/// <see cref="ForwardedHeadersOptions.ForwardLimit"/> caps how many hops back the chain is read, so
/// a client-appended entry behind one trusted proxy is not mistaken for a proxy's own record.
/// </para>
/// <para>
/// The default is loopback, which is exactly the development and single-host deployment shape
/// (a proxy terminating TLS in front of Core on the same machine). A deployment that fronts Core
/// from another host must list that host, or the limiters go back to keying on the proxy.
/// </para>
/// </remarks>
public static class TrustedProxies
{
    /// <summary>
    /// Configuration key for the proxy addresses allowed to set <c>X-Forwarded-For</c>. Accepts a
    /// configuration array or one comma-separated value. Default: loopback.
    /// </summary>
    public const string KnownProxiesConfigurationKey = "Nix:ForwardedHeaders:KnownProxies";

    /// <summary>
    /// Configuration key for trusted proxy networks in CIDR form (<c>10.0.0.0/8</c>). Accepts a
    /// configuration array or one comma-separated value. Default: the loopback networks.
    /// </summary>
    public const string KnownNetworksConfigurationKey = "Nix:ForwardedHeaders:KnownNetworks";

    /// <summary>
    /// Configuration key for how many proxy hops are read from the chain. Default: 1.
    /// </summary>
    public const string ForwardLimitConfigurationKey = "Nix:ForwardedHeaders:ForwardLimit";

    /// <summary>Hops read from the forwarded chain when configuration says nothing.</summary>
    public const int DefaultForwardLimit = 1;

    /// <summary>
    /// Applies the forwarded-header policy to <paramref name="options"/> from
    /// <paramref name="configuration"/>.
    /// </summary>
    /// <param name="options">The options the forwarded-headers middleware will read.</param>
    /// <param name="configuration">Where the trusted-proxy allowlist is declared.</param>
    /// <exception cref="InvalidOperationException">
    /// An entry in either list is not an address or a CIDR network. Refused at boot rather than
    /// silently dropped: a typo in a security allowlist must not read as "trust nothing extra".
    /// </exception>
    public static void Configure(ForwardedHeadersOptions options, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(configuration);

        // Only X-Forwarded-For. Host and Proto are not read: nothing in Core branches on either,
        // and an accepted X-Forwarded-Host is a cache-poisoning and link-forgery primitive.
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor;
        options.ForwardLimit = configuration.GetValue(ForwardLimitConfigurationKey, DefaultForwardLimit);

        // The framework seeds loopback into both lists. They are cleared and rebuilt so the
        // allowlist is exactly what this method says it is, whether or not configuration speaks.
        options.KnownProxies.Clear();
        options.KnownIPNetworks.Clear();

        var proxies = Entries(configuration, KnownProxiesConfigurationKey);
        var networks = Entries(configuration, KnownNetworksConfigurationKey);

        foreach (var entry in proxies)
        {
            options.KnownProxies.Add(ParseAddress(entry));
        }

        foreach (var entry in networks)
        {
            options.KnownIPNetworks.Add(ParseNetwork(entry));
        }

        if (options.KnownProxies.Count == 0 && options.KnownIPNetworks.Count == 0)
        {
            options.KnownProxies.Add(IPAddress.Loopback);
            options.KnownProxies.Add(IPAddress.IPv6Loopback);
        }
    }

    private static List<string> Entries(IConfiguration configuration, string key)
    {
        var section = configuration.GetSection(key);
        var entries = new List<string>();

        // An environment variable is one string, a JSON file is an array; both spellings are
        // accepted so a deployment does not have to know which one this code expected.
        if (!string.IsNullOrWhiteSpace(section.Value))
        {
            entries.AddRange(section.Value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            return entries;
        }

        foreach (var child in section.GetChildren())
        {
            if (!string.IsNullOrWhiteSpace(child.Value))
            {
                entries.Add(child.Value.Trim());
            }
        }

        return entries;
    }

    private static IPAddress ParseAddress(string entry) =>
        IPAddress.TryParse(entry, out var address)
            ? address
            : throw new InvalidOperationException(string.Create(
                CultureInfo.InvariantCulture,
                $"'{entry}' in {KnownProxiesConfigurationKey} is not an IP address."));

    private static IPNetwork ParseNetwork(string entry) =>
        IPNetwork.TryParse(entry, out var network)
            ? network
            : throw new InvalidOperationException(string.Create(
                CultureInfo.InvariantCulture,
                $"'{entry}' in {KnownNetworksConfigurationKey} is not a CIDR network (for example 10.0.0.0/8)."));
}
