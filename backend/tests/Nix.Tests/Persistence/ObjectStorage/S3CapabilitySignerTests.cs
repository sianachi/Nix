using Nix.Persistence.ObjectStorage;
using Nix.Tests.Support;

namespace Nix.Tests.Persistence.ObjectStorage;

public sealed class S3CapabilitySignerTests
{
    private static readonly DateTimeOffset Instant = new(2026, 8, 31, 20, 15, 0, TimeSpan.Zero);

    [Fact]
    public void A_capability_is_method_key_and_expiry_bound()
    {
        var signer = Signer();

        var first = signer.Put("files/tenant/upload id").Url;
        var second = signer.Get("files/tenant/upload id").Url;

        Assert.Equal("/api/nix-objects/files/tenant/upload%20id", first.AbsolutePath);
        Assert.Contains("X-Amz-Expires=300", first.Query, StringComparison.Ordinal);
        Assert.Contains("X-Amz-Date=20260831T201500Z", first.Query, StringComparison.Ordinal);
        Assert.NotEqual(first.Query, second.Query);
        Assert.Equal(Instant.AddMinutes(5), signer.Put("files/tenant/upload id").ExpiresAt);
    }

    [Fact]
    public void Upload_capabilities_bind_size_and_immutable_creation_headers()
    {
        var sized = Signer().PutSized("files/upload", 42).Url;
        var immutable = Signer().PutImmutable("files/version", 42).Url;

        Assert.Contains("X-Amz-SignedHeaders=content-length%3Bhost", sized.Query, StringComparison.Ordinal);
        Assert.Contains(
            "X-Amz-SignedHeaders=content-length%3Bhost%3Bif-none-match",
            immutable.Query,
            StringComparison.Ordinal);
        Assert.NotEqual(sized.Query, immutable.Query);
    }

    [Theory]
    [InlineData("")]
    [InlineData("/absolute")]
    [InlineData("files//object")]
    [InlineData("files/../object")]
    [InlineData("files\\object")]
    public void Unsafe_object_keys_are_refused(string key)
    {
        Assert.Throws<ArgumentException>(() => Signer().Get(key));
    }

    [Fact]
    public void Plain_http_is_limited_to_loopback_development()
    {
        var options = Options();
        options.Endpoint = new Uri("http://objects.internal:9000");

        Assert.Throws<InvalidOperationException>(() =>
            new S3CapabilitySigner(options, new FixedTimeProvider(Instant)));
    }

    [Fact]
    public void A_completely_absent_configuration_is_disabled_without_breaking_the_host()
    {
        var signer = new S3CapabilitySigner(new ObjectStorageOptions(), new FixedTimeProvider(Instant));

        Assert.False(signer.IsConfigured);
        Assert.Throws<InvalidOperationException>(() => signer.Get("files/object"));
    }

    private static S3CapabilitySigner Signer() =>
        new(Options(), new FixedTimeProvider(Instant));

    private static ObjectStorageOptions Options() => new()
    {
        Endpoint = new Uri("https://objects.test/api"),
        Region = "eu-west-2",
        Bucket = "nix-objects",
        AccessKey = "access",
        SecretKey = "secret",
        CapabilitySeconds = 300,
    };
}
