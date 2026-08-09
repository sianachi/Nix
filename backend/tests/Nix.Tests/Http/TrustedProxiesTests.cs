using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Http;

namespace Nix.Tests.Http;

/// <summary>
/// Who the limiters think a client is, once the request has crossed a proxy.
/// </summary>
/// <remarks>
/// Both baseline limiters partition on <see cref="ClientKey"/>, so these tests are about the two
/// failure modes that matter: a proxy that erases the client (every caller shares one bucket), and
/// a header trusted from anyone (the caller picks its own bucket, and can pick a victim's).
/// </remarks>
public sealed class TrustedProxiesTests
{
    [Fact]
    public async Task Two_clients_behind_a_trusted_proxy_keep_separate_partition_keys()
    {
        var middleware = Middleware(Configuration([]));

        var first = await KeyFor(middleware, peer: IPAddress.Loopback, forwardedFor: "203.0.113.5");
        var second = await KeyFor(middleware, peer: IPAddress.Loopback, forwardedFor: "203.0.113.6");

        Assert.Equal(IPAddress.Parse("203.0.113.5"), first);
        Assert.Equal(IPAddress.Parse("203.0.113.6"), second);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public async Task A_forwarded_header_from_an_unknown_peer_is_ignored()
    {
        // The whole point of the allowlist: an unrestricted trust would let a caller both evade its
        // own limit and burn through the window of whatever address it names.
        var middleware = Middleware(Configuration([]));
        var attacker = IPAddress.Parse("198.51.100.7");

        var key = await KeyFor(middleware, peer: attacker, forwardedFor: "203.0.113.5");

        Assert.Equal(attacker, key);
    }

    [Fact]
    public async Task A_configured_proxy_is_trusted_and_the_loopback_default_is_replaced()
    {
        var middleware = Middleware(Configuration(new Dictionary<string, string?>
        {
            [TrustedProxies.KnownProxiesConfigurationKey] = "198.51.100.7",
        }));

        var configured = await KeyFor(middleware, IPAddress.Parse("198.51.100.7"), "203.0.113.5");
        var loopback = await KeyFor(middleware, IPAddress.Loopback, "203.0.113.9");

        Assert.Equal(IPAddress.Parse("203.0.113.5"), configured);
        Assert.Equal(IPAddress.Loopback, loopback);
    }

    [Fact]
    public async Task A_configured_network_trusts_every_proxy_inside_it()
    {
        var middleware = Middleware(Configuration(new Dictionary<string, string?>
        {
            [TrustedProxies.KnownNetworksConfigurationKey] = "10.0.0.0/8",
        }));

        var key = await KeyFor(middleware, IPAddress.Parse("10.4.2.1"), "203.0.113.5");

        Assert.Equal(IPAddress.Parse("203.0.113.5"), key);
    }

    [Fact]
    public void Only_the_last_hop_is_read_so_a_client_appended_entry_is_not_mistaken_for_a_proxys()
    {
        var options = new ForwardedHeadersOptions();

        TrustedProxies.Configure(options, Configuration([]));

        Assert.Equal(TrustedProxies.DefaultForwardLimit, options.ForwardLimit);
        Assert.Equal(ForwardedHeaders.XForwardedFor, options.ForwardedHeaders);
    }

    [Fact]
    public void A_typo_in_the_allowlist_stops_the_host_rather_than_silently_trusting_nothing()
    {
        var configuration = Configuration(new Dictionary<string, string?>
        {
            [TrustedProxies.KnownProxiesConfigurationKey] = "not-an-address",
        });

        Assert.Throws<InvalidOperationException>(
            () => TrustedProxies.Configure(new ForwardedHeadersOptions(), configuration));
    }

    private static async Task<IPAddress> KeyFor(
        ForwardedHeadersMiddleware middleware,
        IPAddress peer,
        string forwardedFor)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = peer;
        context.Request.Headers["X-Forwarded-For"] = forwardedFor;

        await middleware.Invoke(context);

        return ClientKey.For(context);
    }

    private static ForwardedHeadersMiddleware Middleware(IConfiguration configuration)
    {
        var options = new ForwardedHeadersOptions();
        TrustedProxies.Configure(options, configuration);

        return new ForwardedHeadersMiddleware(
            _ => Task.CompletedTask,
            NullLoggerFactory.Instance,
            Options.Create(options));
    }

    private static IConfiguration Configuration(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();
}
