using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;

namespace Nix.Tests.Authentication;

/// <summary>The CLI boundary never turns a PAT or a browser cookie into a CLI refresh credential.</summary>
public sealed class CliLoginCoordinatorTests
{
    [Theory]
    [InlineData("ABCDE-FGHJK", "ABCDEFGHJK")]
    [InlineData("abcde-fghjk", "ABCDEFGHJK")]
    [InlineData("ABCDEFGHJK", "ABCDEFGHJK")]
    [InlineData("ABCDE-FGHIJ", null)]
    [InlineData("ABCDE-FGHJK-extra", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Human_codes_have_a_bounded_unambiguous_alphabet(string? input, string? expected) =>
        Assert.Equal(expected, CliSessionSecret.NormalizeUserCode(input));

    [Fact]
    public void Cli_credentials_are_distinct_random_and_only_hashes_are_persisted()
    {
        var first = CliSessionSecret.Mint();
        var second = CliSessionSecret.Mint();
        var device = CliSessionSecret.MintDevice();
        Assert.StartsWith(CliSessionSecret.Prefix, first.Token, StringComparison.Ordinal);
        Assert.StartsWith(CliSessionSecret.DevicePrefix, device.Token, StringComparison.Ordinal);
        Assert.NotEqual(first.Token, second.Token);
        Assert.Equal(BrowserSessionSecret.Hash(first.Token), first.Hash);
        Assert.Matches("^[0-9a-f]{64}$", first.Hash);
        Assert.DoesNotContain(first.Token, first.Hash, StringComparison.Ordinal);
        Assert.NotNull(CliSessionSecret.NormalizeUserCode(CliSessionSecret.MintUserCode()));
    }

    [Fact]
    public async Task Start_exposes_only_the_user_code_in_the_verification_URL()
    {
        using var tokens = Tokens();
        var fake = new SessionsFake();
        var coordinator = new CliLoginCoordinator(fake, tokens, TimeProvider.System);
        var result = await coordinator.StartAsync(new Uri("https://nix.test"), Cancellation);
        Assert.NotNull(result);
        Assert.Equal(BrowserSessionSecret.Hash(result.DeviceCode), fake.DeviceHash);
        Assert.Equal(BrowserSessionSecret.Hash(CliSessionSecret.NormalizeUserCode(result.UserCode)!), fake.UserHash);
        Assert.Contains(result.UserCode, result.VerificationUri.AbsoluteUri, StringComparison.Ordinal);
        Assert.DoesNotContain(result.DeviceCode, result.VerificationUri.AbsoluteUri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Refresh_caps_the_actual_signed_token_and_metadata_to_the_session_hard_expiry()
    {
        using var tokens = Tokens();
        var refresh = CliSessionSecret.Mint();
        var session = Session(TimeSpan.FromSeconds(65));
        var fake = new SessionsFake { RefreshHash = refresh.Hash, Session = session };
        var coordinator = new CliLoginCoordinator(fake, tokens, TimeProvider.System);
        var result = await coordinator.RefreshAsync(refresh.Token, Cancellation);
        Assert.NotNull(result);
        Assert.True(result.ExpiresAt <= session.ExpiresAt);
        Assert.Equal(result.ExpiresAt.UtcDateTime, new JwtSecurityTokenHandler().ReadJwtToken(result.AccessToken).ValidTo);
        Assert.Equal(session.ExpiresAt, result.SessionExpiresAt);
    }

    [Theory]
    [InlineData("browser")]
    [InlineData("pat")]
    [InlineData("malformed")]
    public async Task Refresh_and_logout_never_accept_unapproved_credential_kinds(string kind)
    {
        using var tokens = Tokens();
        var fake = new SessionsFake();
        var coordinator = new CliLoginCoordinator(fake, tokens, TimeProvider.System);
        var token = kind switch
        {
            "browser" => BrowserSessionSecret.Mint().Token,
            "pat" => "nixpat_" + new string('a', 43),
            _ => "nixcli_" + new string('?', 43),
        };
        Assert.Null(await coordinator.RefreshAsync(token, Cancellation));
        await coordinator.LogoutAsync(token, Cancellation);
        Assert.Equal(0, fake.RefreshCalls);
        Assert.Equal(0, fake.RevokeCalls);
    }

    [Fact]
    public async Task Ended_or_inactive_sessions_do_not_mint_access_tokens()
    {
        using var tokens = Tokens();
        var refresh = CliSessionSecret.Mint();
        var fake = new SessionsFake { RefreshHash = refresh.Hash, Session = Session(TimeSpan.FromSeconds(-1)) };
        var coordinator = new CliLoginCoordinator(fake, tokens, TimeProvider.System);
        Assert.Null(await coordinator.RefreshAsync(refresh.Token, Cancellation));
        fake.Session = Session(TimeSpan.FromMinutes(5)) with { PrincipalStatus = PrincipalStatus.Suspended };
        Assert.Null(await coordinator.RefreshAsync(refresh.Token, Cancellation));
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static AuthenticatedBrowserSession Session(TimeSpan lifetime) => new(BrowserSessionId.Create(),
        TenantId.From(Guid.NewGuid()), PrincipalId.Create(), PrincipalStatus.Active, "CLI Person", DateTimeOffset.UtcNow + lifetime);

    private static SelfIssuedTokenService Tokens()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.cli.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "cli-test-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = key.ExportECPrivateKeyPem(),
        }).Build();
        return new SelfIssuedTokenService(config, TimeProvider.System);
    }

    private sealed class SessionsFake : ICliLoginSessions
    {
        public string? DeviceHash { get; private set; }
        public string? UserHash { get; private set; }
        public string? RefreshHash { get; init; }
        public AuthenticatedBrowserSession? Session { get; set; }
        public int RefreshCalls { get; private set; }
        public int RevokeCalls { get; private set; }

        public ValueTask<bool> StartAsync(string deviceHash, string userHash, CancellationToken cancellationToken)
        {
            DeviceHash = deviceHash;
            UserHash = userHash;
            return ValueTask.FromResult(true);
        }

        public ValueTask<DateTimeOffset?> FindPendingAsync(string userHash, CancellationToken cancellationToken) => ValueTask.FromResult<DateTimeOffset?>(null);
        public ValueTask<bool> DecideAsync(string userHash, string browserHash, bool approve, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<CliLoginRedemption> RedeemAsync(string deviceHash, BrowserSessionId sessionId, string refreshHash, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new CliLoginRedemption("pending", null));
        public ValueTask<AuthenticatedBrowserSession?> FindByRefreshHashAsync(string refreshHash, CancellationToken cancellationToken)
        {
            RefreshCalls++;
            return ValueTask.FromResult(refreshHash == RefreshHash ? Session : null);
        }

        public ValueTask RevokeAsync(string refreshHash, CancellationToken cancellationToken)
        {
            RevokeCalls++;
            return ValueTask.CompletedTask;
        }
    }
}
