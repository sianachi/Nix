using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;
using Nix.Features.Sites;
using Nix.Persistence.Sites;

namespace Nix.Tests.Features.Sites;

/// <summary>Hostname verification, canonical and redirect manifests, and Cloudflare automation against an in-memory API.</summary>
public sealed class SiteHostingTests
{
    private static readonly Guid SiteId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid BuildId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid Workspace = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly DateTimeOffset Now = new(2026, 10, 11, 12, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void A_pending_hostname_verifies_on_a_found_token_and_a_verified_one_survives_until_the_third_failure()
    {
        var host = Custom("docs.example.org", verified: false);
        var missing = new SiteHostnameCheck(true, false, "txt_missing");
        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, missing, Now));
        Assert.Null(host.VerifiedAt);
        Assert.Equal(0, host.CheckFailures);

        Assert.Equal(SiteHostnameTransition.Verified, SiteHostnameRules.Apply(host, new SiteHostnameCheck(true, true, null), Now));
        Assert.Equal(Now, host.VerifiedAt);

        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, missing, Now.AddMinutes(1)));
        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, SiteHostnameCheck.Unavailable, Now.AddMinutes(2)));
        Assert.Equal(1, host.CheckFailures);
        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, new SiteHostnameCheck(true, true, null), Now.AddMinutes(3)));
        Assert.Equal(0, host.CheckFailures);

        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, missing, Now.AddMinutes(4)));
        Assert.Equal(SiteHostnameTransition.Unchanged, SiteHostnameRules.Apply(host, missing, Now.AddMinutes(5)));
        Assert.Equal(SiteHostnameTransition.Unverified, SiteHostnameRules.Apply(host, missing, Now.AddMinutes(6)));
        Assert.Null(host.VerifiedAt);
        Assert.Equal("txt_missing", host.CheckError);
    }

    [Fact]
    public void Checks_come_soon_while_pending_or_failing_and_rarely_once_healthy()
    {
        Assert.Equal(Now, SiteHostnameRules.NextCheck(Now, null, null, 0));
        Assert.Equal(Now.AddMinutes(5), SiteHostnameRules.NextCheck(Now, null, Now, 0));
        Assert.Equal(Now.AddDays(7), SiteHostnameRules.NextCheck(Now, null, Now.AddDays(7).AddMinutes(-1), 0));
        Assert.True(SiteHostnameRules.IsAbandoned(Now, null, Now.AddDays(7)));
        Assert.False(SiteHostnameRules.IsAbandoned(Now, Now, Now.AddDays(30)));
        Assert.Equal(Now.AddMinutes(10), SiteHostnameRules.NextCheck(Now, Now, Now, 1));
        Assert.Equal(Now.AddHours(6), SiteHostnameRules.NextCheck(Now, Now, Now, 0));
    }

    [Fact]
    public void The_portfolio_shape_serves_both_hosts_with_the_custom_one_canonical()
    {
        var site = NewSite();
        site.PrimaryHostname = "osinachi.nwagboso.com";
        var hosts = new[] { Default("osinachi.nixsites.com"), Custom("osinachi.nwagboso.com", verified: true) };

        var ops = SiteHostManifests.Puts(site, BuildId, hosts, 4, Now);

        Assert.Equal(2, ops.Count);
        Assert.All(ops, op =>
        {
            using var body = JsonDocument.Parse(op.Body!);
            Assert.Equal("osinachi.nwagboso.com", body.RootElement.GetProperty("canonicalHost").GetString());
            Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("redirectTo").ValueKind);
        });
    }

    [Fact]
    public void A_redirect_alias_carries_the_canonical_origin_and_a_pending_primary_is_never_canonical()
    {
        var site = NewSite();
        site.PrimaryHostname = "www.example.org";
        var alias = Default("demo.sites.example.net");
        alias.ServeMode = SiteHostnameRules.RedirectMode;
        var hosts = new[] { alias, Custom("www.example.org", verified: true) };

        var ops = SiteHostManifests.Puts(site, BuildId, hosts, 1, Now, host => new Uri($"http://{host}:8400/"));

        using (var redirect = JsonDocument.Parse(ops.Single(op => op.Hostname == "demo.sites.example.net").Body!))
        {
            Assert.Equal("http://www.example.org:8400", redirect.RootElement.GetProperty("redirectTo").GetString());
        }

        hosts[1].VerifiedAt = null;
        var pending = SiteHostManifests.Puts(site, BuildId, hosts, 2, Now);
        using var only = JsonDocument.Parse(Assert.Single(pending).Body!);
        Assert.Equal("demo.sites.example.net", only.RootElement.GetProperty("canonicalHost").GetString());
        Assert.Equal(JsonValueKind.Null, only.RootElement.GetProperty("redirectTo").ValueKind);
    }

    [Fact]
    public void A_zone_is_automated_only_for_the_workspace_it_is_handed_to()
    {
        var options = Options();

        Assert.NotNull(options.Cloudflare.ZoneFor("osinachi.nwagboso.com", Workspace));
        Assert.Null(options.Cloudflare.ZoneFor("nwagboso.com", Workspace));
        Assert.Null(options.Cloudflare.ZoneFor("osinachi.nwagboso.com", Guid.NewGuid()));
        Assert.Null(options.Cloudflare.ZoneFor("evilnwagboso.com", Workspace));
    }

    [Fact]
    public async Task Provisioning_is_idempotent_and_removal_deletes_only_what_nix_created()
    {
        var cloudflare = new InMemoryCloudflare();
        var foreign = await cloudflare.CreateRecordAsync(
            "zone-1", new CloudflareDnsRecordInput("TXT", "_nix-site.osinachi.nwagboso.com", "someone-else", false, "theirs"), Ct);
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: true), NullLogger<SiteHostnameProvisioner>.Instance);
        var site = NewSite();
        var host = Custom("osinachi.nwagboso.com", verified: false);

        Assert.True((await provisioner.ProvisionAsync(site, host, Ct)).Changed);
        var again = await provisioner.ProvisionAsync(site, host, Ct);
        Assert.Null(again.Error);
        Assert.False(again.Changed);

        Assert.Equal(3, cloudflare.Records.Count);
        var cname = Assert.Single(cloudflare.Records.Values, record => record.Type == "CNAME");
        Assert.Equal("tunnel-1.cfargotunnel.com", cname.Content);
        Assert.True(cname.Proxied);
        Assert.StartsWith("managed-by nix site ", cname.Comment, StringComparison.Ordinal);
        var ingress = (JsonArray)cloudflare.Tunnel["ingress"]!;
        Assert.Equal(["osinachi.nwagboso.com", "*"], ingress.Select(rule => rule?["hostname"]?.GetValue<string>() ?? "*").ToArray());
        Assert.Equal(2, SiteHostnameProvisioner.Read(host.ManagedRecords)!.Records.Count);

        Assert.Null(await provisioner.RemoveAsync(host, Ct));

        Assert.Equal([foreign.Id], cloudflare.Records.Keys.ToArray());
        Assert.Single((JsonArray)cloudflare.Tunnel["ingress"]!);
        Assert.Null(host.ManagedRecords);
    }

    [Fact]
    public async Task A_routing_record_someone_else_made_is_never_overwritten()
    {
        var cloudflare = new InMemoryCloudflare();
        await cloudflare.CreateRecordAsync("zone-1", new CloudflareDnsRecordInput("A", "osinachi.nwagboso.com", "192.0.2.1", true, string.Empty), Ct);
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: false), NullLogger<SiteHostnameProvisioner>.Instance);
        var host = Custom("osinachi.nwagboso.com", verified: false);

        Assert.Equal("routing_record_foreign", (await provisioner.ProvisionAsync(NewSite(), host, Ct)).Error);

        // All or nothing: the TXT record this run made is gone again, and nothing is owned.
        Assert.Equal("192.0.2.1", Assert.Single(cloudflare.Records.Values).Content);
        Assert.Null(host.ManagedRecords);
    }

    [Fact]
    public async Task A_wildcard_someone_else_made_blocks_routing_and_the_zone_apex_is_never_automated()
    {
        var cloudflare = new InMemoryCloudflare();
        await cloudflare.CreateRecordAsync("zone-1", new CloudflareDnsRecordInput("CNAME", "*.nwagboso.com", "elsewhere.example.net", true, string.Empty), Ct);
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: false), NullLogger<SiteHostnameProvisioner>.Instance);

        Assert.Equal("routing_record_foreign", (await provisioner.ProvisionAsync(NewSite(), Custom("a.b.nwagboso.com", verified: false), Ct)).Error);
        Assert.Single(cloudflare.Records);
        Assert.False(provisioner.Manages("nwagboso.com", Workspace));
        Assert.Null((await provisioner.ProvisionAsync(NewSite(), Custom("nwagboso.com", verified: false), Ct)).Error);
        Assert.Single(cloudflare.Records);
    }

    [Fact]
    public async Task A_failure_part_way_deletes_what_the_run_created_and_a_switched_off_token_keeps_the_ids()
    {
        var cloudflare = new InMemoryCloudflare { FailTunnelWrites = true };
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: true), NullLogger<SiteHostnameProvisioner>.Instance);
        var host = Custom("osinachi.nwagboso.com", verified: false);

        Assert.StartsWith("cloudflare_", (await provisioner.ProvisionAsync(NewSite(), host, Ct)).Error, StringComparison.Ordinal);
        Assert.Empty(cloudflare.Records);
        Assert.Null(host.ManagedRecords);

        host.ManagedRecords = "{\"zoneId\":\"zone-1\",\"records\":[\"r9\"],\"tunnel\":false}";
        var off = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, new SiteOptions { Domain = "sites.example.net" }, NullLogger<SiteHostnameProvisioner>.Instance);
        Assert.Equal("cloudflare_not_configured", await off.RemoveAsync(host, Ct));
        Assert.NotNull(host.ManagedRecords);
    }

    [Fact]
    public async Task A_tunnel_configuration_without_an_ingress_list_is_never_rewritten()
    {
        var cloudflare = new InMemoryCloudflare { Tunnel = new JsonObject { ["warp-routing"] = new JsonObject() } };
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: true), NullLogger<SiteHostnameProvisioner>.Instance);
        var host = Custom("osinachi.nwagboso.com", verified: false);

        Assert.Equal("cloudflare_malformed", (await provisioner.ProvisionAsync(NewSite(), host, Ct)).Error);
        Assert.Equal(0, cloudflare.TunnelWrites);
        Assert.Empty(cloudflare.Records);
        Assert.Null(host.ManagedRecords);
    }

    [Fact]
    public async Task A_rule_with_a_hostname_that_is_not_a_string_is_skipped_not_fatal()
    {
        var cloudflare = new InMemoryCloudflare
        {
            Tunnel = new JsonObject
            {
                ["ingress"] = new JsonArray(
                    new JsonObject { ["hostname"] = 5, ["service"] = "http://other" },
                    new JsonObject { ["service"] = "http_status:404" }),
            },
        };
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: true), NullLogger<SiteHostnameProvisioner>.Instance);
        var host = Custom("osinachi.nwagboso.com", verified: false);

        Assert.Null((await provisioner.ProvisionAsync(NewSite(), host, Ct)).Error);
        Assert.Equal(3, ((JsonArray)cloudflare.Tunnel["ingress"]!).Count);
        Assert.Null(await provisioner.RemoveAsync(host, Ct));
        Assert.Equal(2, ((JsonArray)cloudflare.Tunnel["ingress"]!).Count);
    }

    [Fact]
    public async Task A_suffixed_default_hostname_gets_a_tunnel_record_in_the_configured_zone_idempotently_and_loses_it_on_delete()
    {
        var cloudflare = new InMemoryCloudflare();
        // The unsuffixed instance's wildcard on the shared zone never blocks the exact record.
        var wildcard = await cloudflare.CreateRecordAsync(
            "other", new CloudflareDnsRecordInput("CNAME", "*.nixsites.com", "elsewhere.example.net", true, string.Empty), Ct);
        cloudflare.WrittenZones.Clear();
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, SuffixedOptions(), NullLogger<SiteHostnameProvisioner>.Instance);
        var site = NewSite();
        var host = Default("demo-home.nixsites.com");

        var first = await provisioner.EnsureDefaultAsync(site, host, Ct);
        Assert.Null(first.Error);
        Assert.True(first.Changed);
        var again = await provisioner.EnsureDefaultAsync(site, host, Ct);
        Assert.Null(again.Error);
        Assert.False(again.Changed);

        var cname = Assert.Single(cloudflare.Records.Values, record => record.Name == "demo-home.nixsites.com");
        Assert.Equal("CNAME", cname.Type);
        Assert.Equal("tunnel-1.cfargotunnel.com", cname.Content);
        Assert.True(cname.Proxied);
        Assert.Equal(2, cloudflare.Records.Count);
        Assert.Equal([DefaultZone], cloudflare.WrittenZones.Distinct().ToArray());
        var rule = (JsonObject)((JsonArray)cloudflare.Tunnel["ingress"]!)[0]!;
        Assert.Equal("demo-home.nixsites.com", rule["hostname"]!.GetValue<string>());
        Assert.Equal("http://nix-web:8090", rule["service"]!.GetValue<string>());
        var owned = SiteHostnameProvisioner.Read(host.ManagedRecords)!;
        Assert.Equal(DefaultZone, owned.ZoneId);
        Assert.Equal([cname.Id], owned.Records);
        Assert.True(owned.Tunnel);

        Assert.Null(await provisioner.RemoveAsync(host, Ct));
        Assert.Equal([wildcard.Id], cloudflare.Records.Keys.ToArray());
        Assert.Single((JsonArray)cloudflare.Tunnel["ingress"]!);
        Assert.Null(host.ManagedRecords);
    }

    [Theory]
    [InlineData("demo.nixsites.com", SiteRules.DefaultHost)]
    [InlineData("a.demo-home.nixsites.com", SiteRules.DefaultHost)]
    [InlineData("demo-home.example.org", SiteRules.DefaultHost)]
    [InlineData("demo-home.nixsites.com", SiteRules.CustomHost)]
    public async Task Only_a_default_hostname_of_the_instance_shape_is_ever_written_in_the_default_zone(string name, string kind)
    {
        var cloudflare = new InMemoryCloudflare();
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, SuffixedOptions(), NullLogger<SiteHostnameProvisioner>.Instance);
        var host = kind == SiteRules.DefaultHost ? Default(name) : Custom(name, verified: false);

        Assert.Equal(new SiteProvisioning(null, false), await provisioner.EnsureDefaultAsync(NewSite(), host, Ct));
        Assert.Equal(new SiteProvisioning(null, false), await provisioner.ProvisionAsync(NewSite(), host, Ct));
        Assert.Empty(cloudflare.Records);
        Assert.Equal(0, cloudflare.TunnelWrites);
        Assert.Null(host.ManagedRecords);
    }

    [Fact]
    public async Task An_unsuffixed_instance_never_writes_a_default_hostname_record()
    {
        var cloudflare = new InMemoryCloudflare();
        var provisioner = new SiteHostnameProvisioner(cloudflare, NoLock.Instance, Options(tunnel: true), NullLogger<SiteHostnameProvisioner>.Instance);

        Assert.False((await provisioner.EnsureDefaultAsync(NewSite(), Default("demo.sites.example.net"), Ct)).Changed);
        Assert.Empty(cloudflare.Records);
    }

    [Theory]
    [InlineData("nixsites.com", "nixsites.com", null)]
    [InlineData("nixsites.com", "home.nixsites.com", null)]
    [InlineData("home.nixsites.com", "nixsites.com", null)]
    [InlineData("example.com", "sites.example.net", "app.example.com")]
    public void A_managed_zone_overlapping_the_sites_domain_or_the_app_domain_is_refused(string zone, string sitesDomain, string? appHost)
    {
        var options = new SiteCloudflareOptions { ApiToken = "token" };
        options.ManagedZones.Add(new SiteManagedZone { Zone = zone, WorkspaceId = Workspace });

        Assert.Throws<InvalidOperationException>(() => options.AssertValid(sitesDomain, appHost));
        options.ManagedZones.Clear();
        options.ManagedZones.Add(new SiteManagedZone { Zone = "nwagboso.com", WorkspaceId = Workspace });
        options.AssertValid(sitesDomain, appHost);
    }

    [Fact]
    public async Task The_checker_trusts_only_the_exact_token_and_treats_a_dead_resolver_as_inconclusive()
    {
        var host = Custom("docs.example.org", verified: false);
        var dns = new FakeDns { ["_nix-site.docs.example.org/TXT"] = ["nix-site-verification=wrong"] };
        Assert.Equal("txt_mismatch", (await new SiteHostnameChecker(dns).CheckAsync(host, Ct)).Error);

        dns["_nix-site.docs.example.org/TXT"] = [SiteHostnameRules.VerificationValue(host.VerificationToken!)];
        var routedless = await new SiteHostnameChecker(dns).CheckAsync(host, Ct);
        Assert.True(routedless.TokenFound);
        Assert.Equal("routing_missing", routedless.Error);

        dns.Fail = true;
        Assert.False((await new SiteHostnameChecker(dns).CheckAsync(host, Ct)).Conclusive);
    }

    [Fact]
    public void A_doh_reply_is_read_with_txt_strings_joined_and_nxdomain_empty()
    {
        using var reply = JsonDocument.Parse("""
            {"Status":0,"Answer":[{"name":"x","type":5,"data":"y."},{"name":"x","type":16,"data":"\"nix-site-\" \"verification=abc\""}]}
            """);
        Assert.Equal(["nix-site-verification=abc"], DohSiteDnsResolver.Read(reply.RootElement, 16));
        Assert.Equal(["y"], DohSiteDnsResolver.Read(reply.RootElement, 5));
        using var missing = JsonDocument.Parse("""{"Status":3}""");
        Assert.Empty(DohSiteDnsResolver.Read(missing.RootElement, 16));
        using var failed = JsonDocument.Parse("""{"Status":2}""");
        Assert.Throws<SiteDnsUnavailableException>(() => DohSiteDnsResolver.Read(failed.RootElement, 16));
    }

    [Fact]
    public async Task A_tunnel_reply_without_its_configuration_is_an_error_never_an_empty_config()
    {
        using var handler = new Canned("{\"success\":true,\"errors\":[],\"result\":{\"tunnel_id\":\"t\"}}");
        using var http = new HttpClient(handler);
        var client = new CloudflareDnsClient(http, "token", "account", "tunnel");

        var refused = await Assert.ThrowsAsync<CloudflareApiException>(() => client.GetTunnelConfigAsync(Ct));
        Assert.Equal("cloudflare_malformed", refused.Message);
        Assert.Equal("Bearer", handler.Authorization?.Scheme);
    }

    [Fact]
    public void A_check_key_stays_under_the_scheduler_bound_for_the_longest_hostname()
    {
        var key = SiteHostnameCheckTriggerSource.Key(SiteId, new string('a', 63) + "." + new string('b', 63) + ".example.org", Now);
        Assert.True(key.Length <= 200);
    }

    private static SiteOptions Options(bool tunnel = false)
    {
        var options = new SiteOptions { Enabled = true, Domain = "sites.example.net" };
        options.Cloudflare.ApiToken = "token";
        options.Cloudflare.AccountId = "account-1";
        options.Cloudflare.DefaultTarget = "nixsites.com";
        options.Cloudflare.TunnelId = tunnel ? "tunnel-1" : null;
        options.Cloudflare.ManagedZones.Add(new SiteManagedZone { Zone = "nwagboso.com", WorkspaceId = Workspace });
        return options;
    }

    private const string DefaultZone = "0123456789abcdef0123456789abcdef";

    private static SiteOptions SuffixedOptions()
    {
        var options = new SiteOptions { Enabled = true, Domain = "nixsites.com", DefaultHostLabelSuffix = "-home" };
        options.Cloudflare.ApiToken = "token";
        options.Cloudflare.AccountId = "account-1";
        options.Cloudflare.TunnelId = "tunnel-1";
        options.Cloudflare.TunnelService = "http://nix-web:8090";
        options.Cloudflare.DefaultHostnameZoneId = DefaultZone;
        return options;
    }

    private static Site NewSite() => new()
    {
        TenantId = TenantId.From(Guid.NewGuid()),
        Id = SiteId,
        WorkspaceId = WorkspaceId.From(Workspace),
        RootItemId = ItemId.From(Guid.NewGuid()),
        Slug = "demo",
        CreatedBy = PrincipalId.From(Guid.NewGuid()),
        CreatedAt = Now,
        UpdatedAt = Now,
    };

    private static SiteHostname Default(string hostname) => new()
    {
        TenantId = TenantId.From(Guid.NewGuid()),
        Hostname = hostname,
        SiteId = SiteId,
        Kind = SiteRules.DefaultHost,
        VerifiedAt = Now,
        CreatedAt = Now,
    };

    private static SiteHostname Custom(string hostname, bool verified) => new()
    {
        TenantId = TenantId.From(Guid.NewGuid()),
        Hostname = hostname,
        SiteId = SiteId,
        Kind = SiteRules.CustomHost,
        VerifiedAt = verified ? Now : null,
        CreatedAt = Now,
        VerificationToken = SiteHostnameRules.NewToken(),
    };

    private sealed class Canned(string body) : HttpMessageHandler
    {
        public System.Net.Http.Headers.AuthenticationHeaderValue? Authorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Authorization = request.Headers.Authorization;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class NoLock : ISiteTunnelLock
    {
        public static readonly NoLock Instance = new();

        public ValueTask LockAsync(CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }

    private sealed class FakeDns : Dictionary<string, string[]>, ISiteDnsResolver
    {
        public bool Fail { get; set; }

        public Task<IReadOnlyList<string>> QueryAsync(string name, string type, CancellationToken cancellationToken) =>
            Fail
                ? throw new SiteDnsUnavailableException("down")
                : Task.FromResult<IReadOnlyList<string>>(TryGetValue(name + "/" + type, out var values) ? values : []);
    }
}

/// <summary>The Cloudflare API slice in memory: one zone, its records, and one tunnel configuration.</summary>
internal sealed class InMemoryCloudflare : ICloudflareDns
{
    private int _next;

    public Dictionary<string, CloudflareDnsRecord> Records { get; } = [];

    public JsonObject Tunnel { get; set; } = new() { ["ingress"] = new JsonArray(new JsonObject { ["service"] = "http_status:404" }) };

    public Task<string?> FindZoneIdAsync(string zoneName, CancellationToken cancellationToken) => Task.FromResult<string?>("zone-1");

    public Task<IReadOnlyList<CloudflareDnsRecord>> ListRecordsAsync(string zoneId, string name, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>([.. Records.Values.Where(record => record.Name == name)]);

    public List<string> WrittenZones { get; } = [];

    public Task<CloudflareDnsRecord> CreateRecordAsync(string zoneId, CloudflareDnsRecordInput record, CancellationToken cancellationToken)
    {
        WrittenZones.Add(zoneId);
        var created = new CloudflareDnsRecord("r" + ++_next, record.Type, record.Name, record.Content, record.Proxied, record.Comment);
        Records[created.Id] = created;
        return Task.FromResult(created);
    }

    public Task<CloudflareDnsRecord> UpdateRecordAsync(string zoneId, string recordId, CloudflareDnsRecordInput record, CancellationToken cancellationToken)
    {
        var updated = new CloudflareDnsRecord(recordId, record.Type, record.Name, record.Content, record.Proxied, record.Comment);
        Records[recordId] = updated;
        return Task.FromResult(updated);
    }

    public Task DeleteRecordAsync(string zoneId, string recordId, CancellationToken cancellationToken)
    {
        Records.Remove(recordId);
        return Task.CompletedTask;
    }

    public Task<JsonObject> GetTunnelConfigAsync(CancellationToken cancellationToken) => Task.FromResult((JsonObject)Tunnel.DeepClone());

    public bool FailTunnelWrites { get; init; }

    public int TunnelWrites { get; private set; }

    public Task PutTunnelConfigAsync(JsonObject config, CancellationToken cancellationToken)
    {
        if (FailTunnelWrites)
        {
            throw new CloudflareApiException("cloudflare_500");
        }

        Tunnel = (JsonObject)config.DeepClone();
        TunnelWrites++;
        return Task.CompletedTask;
    }
}
