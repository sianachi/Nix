using Microsoft.Extensions.Configuration;
using Nix.Features.Sites;

namespace Nix.Tests.Features.Sites;

public sealed class SiteOptionsTests
{
    private const string ZoneId = "0123456789abcdef0123456789abcdef";

    [Theory]
    [InlineData("sites.example.net", "app.example.com", false, true)]
    [InlineData("sites.example.net", null, false, true)]
    [InlineData("example.net", "example.com", false, true)]
    [InlineData("sites.example.com", "app.example.com", false, false)]
    [InlineData("example.com", "example.com", false, false)]
    [InlineData("EXAMPLE.com.", "example.com", false, false)]
    [InlineData("sites.example.com", "example.com", false, false)]
    [InlineData("example.com", "app.example.com", false, false)]
    [InlineData("a.deep.sites.example.com", "app.example.com", false, false)]
    [InlineData("sites.localhost", "localhost", false, false)]
    [InlineData("sites.localhost", "localhost", true, true)]
    [InlineData("sites.localhost", "app.localhost", true, true)]
    [InlineData("localhost", "localhost", true, false)]
    [InlineData("sites.example.com", "app.example.com", true, false)]
    public void The_sites_domain_must_not_share_a_registrable_domain_with_the_app(
        string sitesDomain, string? appHost, bool development, bool acceptable)
    {
        var refusal = SiteDomainPolicy.Check(sitesDomain, appHost, development);

        Assert.Equal(acceptable, refusal is null);
    }

    [Theory]
    [InlineData("nixsites.com", "nixsites.com", true, true)]
    [InlineData("nixsites.com", "nixsites.com", false, false)]
    [InlineData("sites.nixsites.com", "nixsites.com", true, false)]
    [InlineData("nixsites.com", "app.nixsites.com", true, false)]
    [InlineData("home.nixsites.com", "app.example.org", false, true)]
    public void The_sites_domain_may_equal_the_app_apex_only_when_the_shared_layout_is_configured(
        string sitesDomain, string appHost, bool shared, bool acceptable)
    {
        Assert.Equal(acceptable, SiteDomainPolicy.Check(sitesDomain, appHost, isDevelopment: false, shared) is null);
    }

    [Fact]
    public void A_shared_apex_deployment_starts_and_never_hands_out_an_infrastructure_or_unowned_reserved_slug()
    {
        var owner = Guid.NewGuid();
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "nixsites.com",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:SharedAppDomain"] = "true",
            ["Nix:Sites:ReservedSlugOwners:nix"] = owner.ToString(),
            ["Nix:Sites:ReservedSlugOwners:www"] = owner.ToString(),
            ["Nix:Bff:PublicOrigin"] = "https://nixsites.com",
        });

        options.AssertValid("nixsites.com", isDevelopment: false);

        Assert.True(options.IsAppHost("nixsites.com"));
        Assert.True(options.MayClaimSlug("nix", owner));
        Assert.False(options.MayClaimSlug("nix", Guid.NewGuid()));
        Assert.False(options.MayClaimSlug("osinachi", owner));
        Assert.False(options.MayClaimSlug("www", owner));
        Assert.False(options.MayClaimSlug("home", owner));
        Assert.True(options.MayClaimSlug("my-notes", Guid.NewGuid()));
        Assert.Equal(20, options.MaximumSitesPerTenant);
    }

    [Fact]
    public void A_suffixed_instance_derives_one_level_hostnames_and_automates_only_its_own_shape()
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "nixsites.com",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:DefaultHostLabelSuffix"] = "-home",
            ["Nix:Sites:Cloudflare:ApiToken"] = "token",
            ["Nix:Sites:Cloudflare:DefaultHostnameZoneId"] = ZoneId,
            ["Nix:Bff:PublicOrigin"] = "https://app.example.org",
        });

        options.AssertValid("app.example.org", isDevelopment: false);

        Assert.Equal("osinachi-home.nixsites.com", options.DefaultHostname("osinachi"));
        Assert.True(options.Cloudflare.IsEnabled);
        Assert.Null(options.Cloudflare.ZoneFor("osinachi-home.nixsites.com", Guid.NewGuid()));
        Assert.True(options.AutomatesDefaultHostname("osinachi-home.nixsites.com"));
        Assert.True(options.AutomatesDefaultHostname("a-b-home.nixsites.com"));
        Assert.False(options.AutomatesDefaultHostname("osinachi.nixsites.com"));
        Assert.False(options.AutomatesDefaultHostname("-home.nixsites.com"));
        Assert.False(options.AutomatesDefaultHostname("a.b-home.nixsites.com"));
        Assert.False(options.AutomatesDefaultHostname("osinachi-home.nixsites.com.evil.net"));
        Assert.False(options.AutomatesDefaultHostname("osinachi-home.other.com"));

        // Custom hostnames under the shared sites domain stay refused, the suffixed namespace included.
        Assert.NotNull(SiteHostnamePolicy.Refusal(options, "docs-home.nixsites.com"));
        Assert.NotNull(SiteHostnamePolicy.Refusal(options, "docs.nixsites.com"));
        Assert.Null(SiteHostnamePolicy.Refusal(options, "docs.example.net"));
    }

    [Fact]
    public void The_unsuffixed_instance_refuses_slugs_in_a_foreign_namespace_and_the_app_host()
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "nixsites.com",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:SharedAppDomain"] = "true",
            ["Nix:Sites:ForeignLabelSuffixes:0"] = "-home",
            ["Nix:Sites:ForeignLabelSuffixes:1"] = "",
            ["Nix:Bff:PublicOrigin"] = "https://nixsites.com",
        });

        options.AssertValid("nixsites.com", isDevelopment: false);

        Assert.Equal(["-home"], options.ForeignLabelSuffixes);
        Assert.False(options.MayClaimSlug("osinachi-home", Guid.NewGuid()));
        Assert.True(options.MayClaimSlug("homework", Guid.NewGuid()));
        Assert.True(options.MayClaimSlug("my-home-page", Guid.NewGuid()));
        Assert.False(options.AutomatesDefaultHostnames);

        var home = Bind(new()
        {
            ["Nix:Sites:Domain"] = "nixsites.com",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:DefaultHostLabelSuffix"] = "-home",
            ["Nix:Bff:PublicOrigin"] = "https://app-home.nixsites.com",
        });
        Assert.False(home.MayClaimSlug("app", Guid.NewGuid()));
        Assert.True(home.MayClaimSlug("notes", Guid.NewGuid()));
    }

    [Theory]
    [InlineData("Nix:Sites:DefaultHostLabelSuffix", "home")]
    [InlineData("Nix:Sites:DefaultHostLabelSuffix", "-Home")]
    [InlineData("Nix:Sites:DefaultHostLabelSuffix", "-home.x")]
    [InlineData("Nix:Sites:DefaultHostLabelSuffix", "-a-very-long-suffix-label")]
    [InlineData("Nix:Sites:ForeignLabelSuffixes:0", "home")]
    [InlineData("Nix:Sites:Cloudflare:DefaultHostnameZoneId", ZoneId)]
    public void A_bad_label_suffix_or_an_unsuffixed_default_zone_stops_startup(string key, string value)
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "sites.example.net",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:Cloudflare:ApiToken"] = "token",
            [key] = value,
        });

        Assert.Throws<InvalidOperationException>(() => options.AssertValid("app.example.com", isDevelopment: false));
    }

    [Theory]
    [InlineData("Nix:Sites:ForeignLabelSuffixes:0", "-home")]
    [InlineData("Nix:Sites:Cloudflare:DefaultHostnameZoneId", "not-a-zone-id")]
    [InlineData("Nix:Sites:Cloudflare:ApiToken", "")]
    public void A_suffixed_instance_refuses_its_own_suffix_as_foreign_and_a_malformed_or_tokenless_zone(string key, string value)
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "nixsites.com",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:DefaultHostLabelSuffix"] = "-home",
            ["Nix:Sites:Cloudflare:ApiToken"] = "token",
            ["Nix:Sites:Cloudflare:DefaultHostnameZoneId"] = ZoneId,
            [key] = value,
        });

        Assert.Throws<InvalidOperationException>(() => options.AssertValid("app.example.org", isDevelopment: false));
    }

    [Fact]
    public void A_disabled_configuration_is_valid_and_serves_nothing()
    {
        var options = SiteOptions.Bind(new ConfigurationBuilder().Build());

        options.AssertValid("app.example.com", isDevelopment: false);
        Assert.False(options.IsEnabled);
    }

    [Fact]
    public void A_valid_configuration_derives_hostnames_and_public_urls()
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "Sites.Example.NET",
            ["Nix:Sites:Bucket"] = "nix-sites",
        });

        options.AssertValid("app.example.com", isDevelopment: false);

        Assert.Equal("docs.sites.example.net", options.DefaultHostname("docs"));
        Assert.Equal("https://docs.sites.example.net/", options.PublicUrl("docs.sites.example.net").AbsoluteUri);
    }

    [Fact]
    public void A_non_default_public_port_appears_in_the_url()
    {
        var options = Bind(new()
        {
            ["Nix:Sites:Domain"] = "sites.localhost",
            ["Nix:Sites:Bucket"] = "nix-sites",
            ["Nix:Sites:PublicScheme"] = "http",
            ["Nix:Sites:PublicPort"] = "8400",
        });

        options.AssertValid("localhost", isDevelopment: true);

        Assert.Equal("http://demo.sites.localhost:8400/", options.PublicUrl("demo.sites.localhost").AbsoluteUri);
    }

    [Fact]
    public void An_unsafe_domain_stops_startup()
    {
        var options = Bind(new() { ["Nix:Sites:Domain"] = "sites.example.com", ["Nix:Sites:Bucket"] = "nix-sites" });

        var failure = Assert.Throws<InvalidOperationException>(() => options.AssertValid("app.example.com", isDevelopment: false));
        Assert.Contains("Nix:Sites:Domain", failure.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Nix:Sites:Bucket", "")]
    [InlineData("Nix:Sites:Bucket", "x")]
    [InlineData("Nix:Sites:PublicScheme", "http")]
    [InlineData("Nix:Sites:PublicScheme", "ftp")]
    [InlineData("Nix:Sites:PublicPort", "70000")]
    [InlineData("Nix:Sites:BuildsRetained", "0")]
    [InlineData("Nix:Sites:MaximumSitesPerTenant", "0")]
    [InlineData("Nix:Sites:Domain", "not a domain")]
    public void An_unusable_value_stops_startup(string key, string value)
    {
        var values = new Dictionary<string, string?>
        {
            ["Nix:Sites:Domain"] = "sites.example.net",
            ["Nix:Sites:Bucket"] = "nix-sites",
            [key] = value,
        };
        var options = Bind(values);

        Assert.Throws<InvalidOperationException>(() => options.AssertValid("app.example.com", isDevelopment: false));
    }

    private static SiteOptions Bind(Dictionary<string, string?> values) =>
        SiteOptions.Bind(new ConfigurationBuilder().AddInMemoryCollection(values).Build());
}
