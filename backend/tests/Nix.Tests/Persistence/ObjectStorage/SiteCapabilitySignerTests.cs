using Nix.Persistence.ObjectStorage;
using Nix.Tests.Support;

namespace Nix.Tests.Persistence.ObjectStorage;

public sealed class SiteCapabilitySignerTests
{
    private static readonly DateTimeOffset Instant = new(2026, 10, 11, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid SiteId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid BuildId = Guid.Parse("22222222-2222-4222-8222-222222222222");

    [Fact]
    public void Capabilities_address_the_sites_bucket_not_the_private_one()
    {
        var signer = SiteCapabilitySigner.For(Storage(), "nix-sites", new FixedTimeProvider(Instant));

        var url = signer.PutImmutableVerified("sites/_hosts/docs.example.test.json", 10, new string('b', 64)).Url;

        Assert.True(signer.IsConfigured);
        Assert.StartsWith("/api/nix-sites/sites/_hosts/", url.AbsolutePath, StringComparison.Ordinal);
    }

    [Fact]
    public void A_host_manifest_capability_lives_at_most_five_minutes_whatever_the_store_default()
    {
        var storage = Storage();
        storage.CapabilitySeconds = 900;
        var signer = SiteCapabilitySigner.For(storage, "nix-sites", new FixedTimeProvider(Instant));

        var host = signer.PutHostManifest("sites/_hosts/docs.example.test.json", 10, new string('b', 64));
        var delete = signer.DeleteHostManifest("sites/_hosts/docs.example.test.json");
        var build = signer.PutImmutableVerified($"sites/{SiteId:D}/builds/{BuildId:D}/index.html", 10, new string('b', 64));

        Assert.Equal(Instant.AddMinutes(5), host.ExpiresAt);
        Assert.Equal(Instant.AddMinutes(5), delete.ExpiresAt);
        Assert.Equal(Instant.AddMinutes(15), build.ExpiresAt);
        Assert.Contains("X-Amz-Expires=300", host.Url.Query, StringComparison.Ordinal);
    }

    [Fact]
    public void Without_an_object_store_or_a_bucket_the_signer_reports_itself_unconfigured()
    {
        Assert.False(SiteCapabilitySigner.For(new ObjectStorageOptions(), "nix-sites", new FixedTimeProvider(Instant)).IsConfigured);
        Assert.False(SiteCapabilitySigner.For(Storage(), string.Empty, new FixedTimeProvider(Instant)).IsConfigured);
    }

    [Fact]
    public void Build_and_asset_keys_are_derived_from_identities_and_a_validated_path()
    {
        var sha = new string('c', 64);

        Assert.Equal(
            $"sites/{SiteId:D}/builds/{BuildId:D}/blog/hello/index.html",
            ObjectStorageKeys.SiteBuild(SiteId, BuildId, "blog/hello/index.html"));
        Assert.Equal($"sites/{SiteId:D}/assets/{sha}.png", ObjectStorageKeys.SiteAsset(SiteId, sha, "png"));
        Assert.Equal($"sites/{SiteId:D}/assets/{sha}.svg", ObjectStorageKeys.SiteAsset(SiteId, sha, "svg"));
        Assert.Equal($"sites/{SiteId:D}/assets/{sha}.mp4", ObjectStorageKeys.SiteAsset(SiteId, sha, "mp4"));
        Assert.Equal($"sites/{SiteId:D}/assets/{sha}.webm", ObjectStorageKeys.SiteAsset(SiteId, sha, "webm"));
        Assert.Equal($"sites/{SiteId:D}/assets/{sha}.pdf", ObjectStorageKeys.SiteAsset(SiteId, sha, "pdf"));
        Assert.Equal("sites/_hosts/docs.example.test.json", ObjectStorageKeys.SiteHost("docs.example.test"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("/index.html")]
    [InlineData("a//b.html")]
    [InlineData("../index.html")]
    [InlineData("a/../b.html")]
    [InlineData(".hidden/index.html")]
    [InlineData("a\\b.html")]
    [InlineData("a b.html")]
    [InlineData("a/b/c/d/e/f/g/h/i.html")]
    public void An_unsafe_build_path_is_refused(string path)
    {
        Assert.Throws<ArgumentException>(() => ObjectStorageKeys.SiteBuild(SiteId, BuildId, path));
    }

    [Theory]
    [InlineData("not-a-digest", "png")]
    [InlineData("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "gif")]
    [InlineData("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "html")]
    [InlineData("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", "png")]
    public void An_asset_must_be_a_lowercase_digest_with_a_raster_extension(string sha, string extension)
    {
        Assert.Throws<ArgumentException>(() => ObjectStorageKeys.SiteAsset(SiteId, sha, extension));
    }

    [Theory]
    [InlineData("UPPER.example.test")]
    [InlineData("nodots")]
    [InlineData("../evil.example.test")]
    public void A_host_manifest_key_needs_a_valid_lowercase_hostname(string hostname)
    {
        Assert.Throws<ArgumentException>(() => ObjectStorageKeys.SiteHost(hostname));
    }

    private static ObjectStorageOptions Storage() => new()
    {
        Endpoint = new Uri("https://objects.test/api"),
        Region = "eu-west-2",
        Bucket = "nix-objects",
        AccessKey = "access",
        SecretKey = "secret",
        CapabilitySeconds = 300,
    };
}
