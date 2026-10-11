using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Sites;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] The review fixes that sit around a site rather than in its manifest: reserved slugs, the
/// per-tenant cap, hostnames that cannot be squatted or aimed at the app, purges that would
/// orphan a live site, concurrent publishes, and the audit trail of an update.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteHardeningTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string AppHost = "app.example.org";
    private SiteScenario _scenario = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture, new()
        {
            ["Nix:Bff:PublicOrigin"] = "https://" + AppHost,
            ["Nix:Sites:MaximumSitesPerTenant"] = "2",
            ["Nix:Sites:ReservedSlugOwners:nix"] = TestTenants.AlphaWorkspace.ToString("D"),
        });
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task Reserved_slugs_are_refused_unless_the_deployment_hands_one_to_the_workspace()
    {
        Assert.Equal(SiteErrors.SlugReservedCode, (await CreateAsync(Root, "www")).Error.Code);
        Assert.Equal(SiteErrors.SlugReservedCode, (await CreateAsync(Root, "home")).Error.Code);
        Assert.Equal(SiteErrors.SlugReservedCode, (await CreateAsync(Root, "osinachi")).Error.Code);

        var owned = await CreateAsync(Root, "nix");
        Assert.True(owned.IsSuccess, owned.IsFailure ? owned.Error.Message : string.Empty);
    }

    [Fact]
    public async Task A_tenant_cannot_have_more_sites_than_the_deployment_allows()
    {
        Assert.True((await CreateAsync(await RootAsync("One"), "one")).IsSuccess);
        Assert.True((await CreateAsync(await RootAsync("Two"), "two")).IsSuccess);

        Assert.Equal(SiteErrors.LimitReachedCode, (await CreateAsync(await RootAsync("Three"), "three")).Error.Code);
    }

    [Fact]
    public async Task The_app_host_and_the_sites_apex_cannot_be_attached_and_a_pending_claim_blocks_no_one()
    {
        var site = (await CreateAsync(Root, "claims")).Value.Id;

        foreach (var reserved in new[] { AppHost, SiteScenario.Domain, "x." + SiteScenario.Domain })
        {
            var refused = await _scenario.SendAsync<SetSiteHostnames, SiteResponse>(SiteScenario.Manager, new SetSiteHostnames(site, [reserved]));
            Assert.Equal(SiteErrors.HostnameReservedCode, refused.Error.Code);
        }

        var first = await _scenario.SendAsync<SetSiteHostnames, SiteResponse>(SiteScenario.Manager, new SetSiteHostnames(site, ["docs.customer.test"]));
        Assert.True(first.IsSuccess, first.IsFailure ? first.Error.Message : string.Empty);

        // Another tenant's site may claim the same name while neither has proved ownership.
        var other = await _scenario.SendAsync<CreateSite, SiteResponse>(
            TestTenants.BetaContext, new CreateSite(new CreateSiteRequest(M0SchemaSeed.Beta.ItemId, "beta-claims", "docs", null)));
        Assert.True(other.IsSuccess, other.IsFailure ? other.Error.Message : string.Empty);
        var second = await _scenario.SendAsync<SetSiteHostnames, SiteResponse>(
            TestTenants.BetaContext, new SetSiteHostnames(other.Value.Id, ["docs.customer.test"]));
        Assert.True(second.IsSuccess, second.IsFailure ? second.Error.Message : string.Empty);

        // Once one is verified, the name is that site's alone.
        await Sql("UPDATE site_hostname SET verified_at = now() WHERE hostname = 'docs.customer.test' AND tenant_id = '" + TestTenants.Alpha + "'");
        var squat = await Assert.ThrowsAsync<Npgsql.PostgresException>(() =>
            Sql("UPDATE site_hostname SET verified_at = now() WHERE hostname = 'docs.customer.test' AND tenant_id = '" + TestTenants.Beta + "'"));
        Assert.Equal(Npgsql.PostgresErrorCodes.UniqueViolation, squat.SqlState);
    }

    [Fact]
    public async Task A_workspace_or_a_site_root_with_a_published_site_cannot_be_purged()
    {
        var site = (await CreateAsync(Root, "pinned")).Value.Id;
        await PublishedAsync(site);
        await Sql($"UPDATE item SET lifecycle_state = 'deleted', purge_after = now() + interval '30 days' WHERE id = '{Root.Value}'");

        var item = await _scenario.SendAsync<PurgeItem, ItemId>(SiteScenario.Manager, new PurgeItem(Root));
        Assert.True(item.IsFailure);
        Assert.Contains("published site", item.Error.Message, StringComparison.Ordinal);

        await Sql($"UPDATE workspace SET lifecycle_state = 'archived' WHERE workspace_id = '{TestTenants.AlphaWorkspace}'");
        var workspace = await _scenario.SendAsync<PurgeWorkspace, bool>(
            SiteScenario.Manager, new PurgeWorkspace(WorkspaceId.From(TestTenants.AlphaWorkspace)));
        Assert.Equal("workspaces.sites_published", workspace.Error.Code);
        Assert.Equal(["archived"], await Query($"SELECT lifecycle_state FROM workspace WHERE workspace_id = '{TestTenants.AlphaWorkspace}'"));

        // The keys back the refusal: the root cannot be deleted out from under the site.
        var deleted = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => Sql($"DELETE FROM item WHERE id = '{Root.Value}'"));
        Assert.Equal(Npgsql.PostgresErrorCodes.ForeignKeyViolation, deleted.SqlState);
    }

    [Fact]
    public async Task A_site_can_only_point_at_one_of_its_own_builds()
    {
        var mine = (await CreateAsync(Root, "mine")).Value.Id;
        var other = (await CreateAsync(await RootAsync("Other"), "other")).Value.Id;
        await PublishedAsync(other);

        var refused = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => Sql(
            $"UPDATE site SET status = 'published', live_build_id = (SELECT live_build_id FROM site WHERE id = '{other}') WHERE id = '{mine}'"));

        Assert.Equal(Npgsql.PostgresErrorCodes.ForeignKeyViolation, refused.SqlState);
    }

    [Fact]
    public async Task Two_concurrent_publishes_with_one_key_return_one_build()
    {
        var site = (await CreateAsync(Root, "racing")).Value.Id;

        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => _scenario.SendAsync<PublishSite, SiteBuildResponse>(
            SiteScenario.Manager, new PublishSite(site, "same-key", false, true, "manual"))));

        Assert.All(results, result => Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty));
        Assert.Single(results.Select(result => result.Value.Id).Distinct());
        Assert.Equal(["1"], await Query($"SELECT count(*)::text FROM site_build WHERE site_id = '{site}'"));
    }

    [Fact]
    public async Task The_audit_of_an_update_records_the_exclusions_and_dated_collections_before_and_after()
    {
        var site = (await CreateAsync(Root, "audited")).Value.Id;
        var hidden = await _scenario.CreateItemAsync("Hidden", Root);
        var blog = await _scenario.CreateItemAsync("Blog", Root, "folder");

        var updated = await _scenario.SendAsync<UpdateSite, SiteResponse>(
            SiteScenario.Manager,
            new UpdateSite(site, new UpdateSiteRequest(null, null, null, null, [hidden.Value], [new SiteDatedCollectionDto(blog.Value, "published", null, null, null)])));
        Assert.True(updated.IsSuccess, updated.IsFailure ? updated.Error.Message : string.Empty);

        var after = (await Query($"SELECT after::text FROM audit_event WHERE subject_id = '{site}' AND action = 'site.updated'")).Single();
        var before = (await Query($"SELECT before::text FROM audit_event WHERE subject_id = '{site}' AND action = 'site.updated'")).Single();
        Assert.Contains(hidden.Value.ToString("D"), after, StringComparison.Ordinal);
        Assert.Contains(blog.Value.ToString("D"), after, StringComparison.Ordinal);
        Assert.Contains("\"excludedItemIds\": []", before, StringComparison.Ordinal);
    }

    private Task<Nix.Domain.Primitives.Result<SiteResponse>> CreateAsync(ItemId root, string slug) =>
        _scenario.SendAsync<CreateSite, SiteResponse>(SiteScenario.Manager, new CreateSite(new CreateSiteRequest(root.Value, slug, "docs", null)));

    private Task<ItemId> RootAsync(string title) => _scenario.CreateItemAsync(title, Root, "folder");

    private async Task PublishedAsync(Guid siteId)
    {
        var build = Guid.NewGuid();
        await Sql($"""
            INSERT INTO site_build
                (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header, page_count,
                 file_count, total_bytes, loss, created_at, activated_at)
            VALUES ('{TestTenants.Alpha}', '{build}', '{siteId}', 'live', gen_random_uuid(), '{TestTenants.AlphaPrincipal}',
                    'manual', 'live', jsonb_build_object(), 1, 0, 0, '[]'::jsonb, now(), now());
            UPDATE site SET status = 'published', live_build_id = '{build}' WHERE id = '{siteId}';
            """);
    }

    private async Task<List<string>> Query(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.TextListAsync(connection, sql)];
        }
    }

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }
}
