using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.BrowserAuth;

/// <summary>Transfers explicit browser approval into a distinct, bounded CLI session.</summary>
public sealed class CliLoginCoordinator(ICliLoginSessions sessions, SelfIssuedTokenService tokens, TimeProvider clock)
{
    /// <summary>Creates a ten-minute pairing without borrowing the browser cookie.</summary>
    public async ValueTask<CliLoginStartResponse?> StartAsync(Uri publicOrigin, CancellationToken cancellationToken)
    {
        var device = CliSessionSecret.MintDevice();
        var userCode = CliSessionSecret.MintUserCode();
        var userHash = BrowserSessionSecret.Hash(CliSessionSecret.NormalizeUserCode(userCode)!);
        if (!await sessions.StartAsync(device.Hash, userHash, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new CliLoginStartResponse(device.Token, userCode,
            new Uri(publicOrigin, "/auth/cli?user_code=" + userCode),
            clock.GetUtcNow() + TimeSpan.FromMinutes(10), 2);
    }

    /// <summary>Consumes an approval exactly once; a browser credential is never returned.</summary>
    public async ValueTask<CliLoginPollResponse> PollAsync(string? deviceCode, CancellationToken cancellationToken)
    {
        if (!IsSecret(deviceCode, CliSessionSecret.DevicePrefix))
        {
            return new CliLoginPollResponse("expired");
        }

        var refresh = CliSessionSecret.Mint();
        var redeemed = await sessions.RedeemAsync(BrowserSessionSecret.Hash(deviceCode!), BrowserSessionId.Create(),
            refresh.Hash, cancellationToken).ConfigureAwait(false);
        if (redeemed.Session is not { PrincipalStatus: PrincipalStatus.Active } session
            || session.ExpiresAt <= clock.GetUtcNow() + TimeSpan.FromSeconds(1))
        {
            return new CliLoginPollResponse(redeemed.Status == "approved" ? "expired" : redeemed.Status);
        }

        var expiry = AccessExpiry(session);
        return new CliLoginPollResponse("approved", Mint(session, expiry), expiry, refresh.Token, session.ExpiresAt,
            new BrowserProfileResponse(session.PrincipalId.Value.ToString("D", System.Globalization.CultureInfo.InvariantCulture), session.DisplayName));
    }

    /// <summary>Renews short-lived access while both CLI and source browser sessions stand.</summary>
    public async ValueTask<CliLoginTokenResponse?> RefreshAsync(string? refreshToken, CancellationToken cancellationToken)
    {
        if (!IsSecret(refreshToken, CliSessionSecret.Prefix))
        {
            return null;
        }

        var session = await sessions.FindByRefreshHashAsync(BrowserSessionSecret.Hash(refreshToken!), cancellationToken).ConfigureAwait(false);
        if (session is not { PrincipalStatus: PrincipalStatus.Active }
            || session.ExpiresAt <= clock.GetUtcNow() + TimeSpan.FromSeconds(1))
        {
            return null;
        }

        var expiry = AccessExpiry(session);
        return new CliLoginTokenResponse(Mint(session, expiry), expiry, session.ExpiresAt);
    }

    /// <summary>Revokes a CLI credential without accepting ordinary browser cookies or PATs.</summary>
    public async ValueTask LogoutAsync(string? refreshToken, CancellationToken cancellationToken)
    {
        if (IsSecret(refreshToken, CliSessionSecret.Prefix))
        {
            await sessions.RevokeAsync(BrowserSessionSecret.Hash(refreshToken!), cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool IsSecret(string? value, string prefix) => value is not null
        && value.Length == prefix.Length + 43 && value.StartsWith(prefix, StringComparison.Ordinal)
        && value.AsSpan(prefix.Length).IndexOfAnyExcept("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".AsSpan()) < 0;

    private DateTimeOffset AccessExpiry(AuthenticatedBrowserSession session) =>
        DateTimeOffset.FromUnixTimeSeconds(Math.Min(session.ExpiresAt.ToUnixTimeSeconds(), (clock.GetUtcNow() + tokens.Lifetime).ToUnixTimeSeconds()));

    private string Mint(AuthenticatedBrowserSession session, DateTimeOffset expiry) =>
        tokens.MintBrowserSession(session.PrincipalId, session.TenantId, session.Id, expiry);
}

/// <summary>A challenge that exposes only a code to the browser; the device secret stays in the CLI.</summary>
public sealed record CliLoginStartResponse(string DeviceCode, string UserCode, Uri VerificationUri, DateTimeOffset ExpiresAt, int IntervalSeconds);

/// <summary>A CLI's exact device challenge.</summary>
public sealed record CliLoginPollRequest(string? DeviceCode);

/// <summary>A CLI's separately approved refresh credential.</summary>
public sealed record CliLoginTokenRequest(string? RefreshToken);

/// <summary>The client label; Core limits this flow to nixctl rather than displaying untrusted client names.</summary>
public sealed record CliLoginStartRequest(string? ClientName = null);

/// <summary>The pending outcome or a one-time approved credential delivery.</summary>
public sealed record CliLoginPollResponse(string Status, string? AccessToken = null, DateTimeOffset? ExpiresAt = null,
    string? RefreshToken = null, DateTimeOffset? SessionExpiresAt = null, BrowserProfileResponse? Profile = null);

/// <summary>Renewed access capped by the original browser session's hard expiry.</summary>
public sealed record CliLoginTokenResponse(string AccessToken, DateTimeOffset ExpiresAt, DateTimeOffset SessionExpiresAt);
