using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] A site publishes attached PDF, plain-text and CSV files as downloads (ADR-0063), each of
/// at most <see cref="SiteRules.MaximumDownloadBytes"/> and under the same eligibility rules as an
/// image. Any other type, or a larger file, is not eligible.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteDownloadFileTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;
    private Guid _siteId;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(Root.Value, "downloads", "docs", null)));
        _siteId = created.Value.Id;
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task Pdf_text_and_csv_files_within_the_cap_are_eligible_and_others_are_not()
    {
        var pdf = await _scenario.CreateFileAsync("My CV.pdf", "application/pdf", new string('a', 64), byteLength: SiteRules.MaximumDownloadBytes, parent: Root);
        var text = await _scenario.CreateFileAsync("notes.txt", "text/plain", new string('b', 64), parent: Root);
        var csv = await _scenario.CreateFileAsync("data.csv", "text/csv", new string('c', 64), parent: Root);
        var oversized = await _scenario.CreateFileAsync("huge.pdf", "application/pdf", new string('d', 64), byteLength: SiteRules.MaximumDownloadBytes + 1, parent: Root);
        var html = await _scenario.CreateFileAsync("page.html", "text/html", new string('e', 64), parent: Root);
        var outside = await _scenario.CreateFileAsync("elsewhere.pdf", "application/pdf", new string('f', 64));

        var found = await _scenario.ReadAsync(SiteScenario.Manager, async unit => new[]
        {
            await FindFileAsync(unit, pdf),
            await FindFileAsync(unit, text),
            await FindFileAsync(unit, csv),
            await FindFileAsync(unit, oversized),
            await FindFileAsync(unit, html),
            await FindFileAsync(unit, outside),
        });

        Assert.Equal("application/pdf", found[0]?.MediaType);
        Assert.Equal("My CV.pdf", found[0]?.FileName);
        Assert.Equal("text/plain", found[1]?.MediaType);
        Assert.Equal("text/csv", found[2]?.MediaType);
        Assert.Null(found[3]);
        Assert.Null(found[4]);
        Assert.Null(found[5]);
    }

    private async Task<SiteFileCandidate?> FindFileAsync(NixUnitOfWork unit, ItemId file)
    {
        var store = unit.Resolve<ISiteStore>();
        var site = await store.FindAsync(_siteId, Cancellation);
        return await store.FindFileAsync(site!, file, DateTimeOffset.UtcNow, Cancellation);
    }
}
