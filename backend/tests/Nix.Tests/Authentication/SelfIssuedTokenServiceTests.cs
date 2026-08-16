using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

/// <summary>
/// Core's own issuer: what it mints validates against exactly its own parameters, and against
/// nothing else.
/// </summary>
public sealed class SelfIssuedTokenServiceTests
{
    private const string Issuer = "https://nix.test/core";
    private const string Audience = "nix";
    private const string KeyId = "test-signing-key";

    [Fact]
    public void Unconfigured_it_says_so_and_refuses_to_mint()
    {
        using var service = Service(configuration: Configuration(signingKeyPem: null));

        Assert.False(service.IsConfigured);
        Assert.Throws<InvalidOperationException>(() =>
            service.Mint("subject", TenantId.From(Guid.NewGuid()), PersonalAccessTokenId.Create()));
        Assert.Empty(service.DescribePublicKeys().Keys);
    }

    [Fact]
    public void A_key_on_the_wrong_curve_is_treated_as_unconfigured()
    {
        using var wrongCurve = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        using var service = Service(Configuration(wrongCurve.ExportECPrivateKeyPem()));

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public void A_malformed_key_is_treated_as_unconfigured()
    {
        using var service = Service(Configuration("not a pem at all"));

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public async Task A_minted_token_validates_and_carries_its_claims_back()
    {
        using var service = Service(Configuration(FreshKeyPem()));
        var tenantId = TenantId.From(Guid.NewGuid());
        var accessTokenId = PersonalAccessTokenId.Create();

        var token = service.Mint("issuer-subject", tenantId, accessTokenId);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());

        Assert.True(result.IsValid);
        Assert.Equal("issuer-subject", result.ClaimsIdentity.FindFirst("sub")?.Value);
        Assert.True(SelfIssuedTokenService.TryReadClaims(
            result.ClaimsIdentity,
            out var readTenant,
            out var readToken));
        Assert.Equal(tenantId, readTenant);
        Assert.Equal(accessTokenId, readToken);
    }

    [Fact]
    public async Task A_token_signed_by_a_different_key_does_not_validate()
    {
        using var minter = Service(Configuration(FreshKeyPem()));
        using var validator = Service(Configuration(FreshKeyPem()));

        var token = minter.Mint(
            "issuer-subject",
            TenantId.From(Guid.NewGuid()),
            PersonalAccessTokenId.Create());

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, validator.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public async Task A_token_that_has_outlived_its_minutes_does_not_validate()
    {
        var mintedAt = new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);
        using var service = Service(
            Configuration(FreshKeyPem()),
            new Support.FixedTimeProvider(mintedAt));

        var token = service.Mint(
            "issuer-subject",
            TenantId.From(Guid.NewGuid()),
            PersonalAccessTokenId.Create());

        // The validating handler judges lifetime against the real clock, which sits years past
        // the frozen mint. This is the whole reason the mint takes an injected clock: the test
        // can put the expiry wherever it needs it.
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public void A_key_can_arrive_as_a_file_the_way_a_mounted_secret_does()
    {
        var path = Path.Combine(Path.GetTempPath(), $"nix-test-key-{Guid.NewGuid():N}.pem");
        File.WriteAllText(path, FreshKeyPem());
        try
        {
            var values = new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
                [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
                [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
                [SelfIssuedTokenService.SigningKeyFileConfigurationKey] = path,
            };
            using var service = Service(
                new ConfigurationBuilder().AddInMemoryCollection(values).Build());

            Assert.True(service.IsConfigured);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A_key_file_that_does_not_exist_is_treated_as_unconfigured()
    {
        var values = new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
            [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
            [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
            [SelfIssuedTokenService.SigningKeyFileConfigurationKey] = "/nowhere/at/all.pem",
        };
        using var service = Service(
            new ConfigurationBuilder().AddInMemoryCollection(values).Build());

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public void The_key_set_describes_the_public_half_under_its_key_id()
    {
        using var service = Service(Configuration(FreshKeyPem()));

        var jwks = service.DescribePublicKeys();

        var key = Assert.Single(jwks.Keys);
        Assert.Equal("EC", key.Kty);
        Assert.Equal("P-256", key.Crv);
        Assert.Equal(KeyId, key.Kid);
        Assert.Equal("ES256", key.Alg);
        Assert.Equal("sig", key.Use);
        Assert.False(string.IsNullOrEmpty(key.X));
        Assert.False(string.IsNullOrEmpty(key.Y));
    }

    [Fact]
    public void Claims_missing_from_a_signed_token_are_refused_whole()
    {
        var identity = new System.Security.Claims.ClaimsIdentity(
        [
            new System.Security.Claims.Claim("sub", "subject"),
            new System.Security.Claims.Claim(SelfIssuedTokenService.TenantClaim, Guid.NewGuid().ToString("D")),
        ]);

        Assert.False(SelfIssuedTokenService.TryReadClaims(identity, out _, out _));
    }

    private static string FreshKeyPem()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return key.ExportECPrivateKeyPem();
    }

    private static IConfiguration Configuration(string? signingKeyPem)
    {
        var values = new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
            [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
            [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
        };

        if (signingKeyPem is not null)
        {
            values[SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKeyPem;
        }

        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static SelfIssuedTokenService Service(
        IConfiguration configuration,
        TimeProvider? clock = null) =>
        new(configuration, clock ?? TimeProvider.System);
}
