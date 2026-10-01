using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Nix.Authentication;

namespace Nix.Features.CalendarSync;

/// <summary>
/// Data Protection for everything secret calendar sync keeps: refresh tokens, cached access tokens
/// and the OAuth state (ADR-0052, Amendment 1 A2). Each has its own purpose, so a value protected
/// for one can never be unprotected as another.
/// </summary>
/// <remarks>
/// A <see cref="CryptographicException"/> on unprotect means the key ring lost the key (keys not
/// persisted, or rotated out of a restored backup); callers treat it as "reconnect needed".
/// </remarks>
public sealed class CalendarTokenProtector
{
    /// <summary>The refresh-token purpose.</summary>
    public const string RefreshTokenPurpose = "Nix.Calendar.RefreshToken.v1";

    /// <summary>The access-token purpose.</summary>
    public const string AccessTokenPurpose = "Nix.Calendar.AccessToken.v1";

    /// <summary>The OAuth-state purpose.</summary>
    public const string OAuthStatePurpose = "Nix.Calendar.OAuthState.v1";

    private readonly IDataProtector _refresh;
    private readonly IDataProtector _access;
    private readonly ITimeLimitedDataProtector _state;

    /// <summary>Creates the three protectors.</summary>
    public CalendarTokenProtector(IDataProtectionProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        _refresh = provider.CreateProtector(RefreshTokenPurpose);
        _access = provider.CreateProtector(AccessTokenPurpose);
        _state = provider.CreateProtector(OAuthStatePurpose).ToTimeLimitedDataProtector();
    }

    /// <summary>Protects a refresh token for storage.</summary>
    public byte[] ProtectRefreshToken(string token) => _refresh.Protect(Encoding.UTF8.GetBytes(token));

    /// <summary>Recovers a stored refresh token.</summary>
    /// <exception cref="CryptographicException">The key that protected it is gone.</exception>
    public string UnprotectRefreshToken(byte[] protectedToken) => Encoding.UTF8.GetString(_refresh.Unprotect(protectedToken));

    /// <summary>Protects an access token for the short-lived cache.</summary>
    public byte[] ProtectAccessToken(string token) => _access.Protect(Encoding.UTF8.GetBytes(token));

    /// <summary>Recovers a cached access token.</summary>
    /// <exception cref="CryptographicException">The key that protected it is gone.</exception>
    public string UnprotectAccessToken(byte[] protectedToken) => Encoding.UTF8.GetString(_access.Unprotect(protectedToken));

    /// <summary>Protects the OAuth state for <paramref name="lifetime"/>.</summary>
    public string ProtectState(string payload, TimeSpan lifetime) => _state.Protect(payload, lifetime);

    /// <summary>Recovers the OAuth state, or <see langword="null"/> when it was tampered with or expired.</summary>
    public string? UnprotectState(string protectedState)
    {
        try
        {
            return _state.Unprotect(protectedState);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }
}

/// <summary>What the OAuth state binds a provider redirect to.</summary>
/// <param name="Nonce">The value also set in the HttpOnly <c>nix_calendar_oauth</c> cookie.</param>
/// <param name="TenantId">The tenant of the session that started the connect.</param>
/// <param name="PrincipalId">The principal of the session that started the connect.</param>
/// <param name="Provider">The provider it was started for.</param>
/// <param name="Verifier">The PKCE verifier.</param>
/// <param name="Issued">When it was issued.</param>
/// <param name="ReturnTo">The same-origin path to return to.</param>
public sealed record CalendarOAuthStatePayload(
    string Nonce,
    Guid TenantId,
    Guid PrincipalId,
    string Provider,
    string Verifier,
    DateTimeOffset Issued,
    string ReturnTo);

/// <summary>
/// Encodes, decodes and checks the calendar OAuth state (ADR-0052 Amendment 1 A1): Data
/// Protection-protected, ten minutes, bound to the principal, tenant and provider, and to a nonce
/// cookie only the browser that started the flow holds.
/// </summary>
public static class CalendarOAuthState
{
    /// <summary>How long a started connect stays valid.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    /// <summary>The nonce cookie's name.</summary>
    public const string CookieName = "nix_calendar_oauth";

    /// <summary>The nonce cookie's path: only the callback ever receives it.</summary>
    public const string CookiePath = "/auth/calendar/callback";

    /// <summary>Joins the payload with newlines; the return path is base64 so it cannot inject a field.</summary>
    public static string Encode(CalendarOAuthStatePayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return string.Join(
            '\n',
            payload.Nonce,
            payload.PrincipalId.ToString("D", CultureInfo.InvariantCulture),
            payload.TenantId.ToString("D", CultureInfo.InvariantCulture),
            payload.Provider,
            payload.Verifier,
            payload.Issued.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
            Convert.ToBase64String(Encoding.UTF8.GetBytes(payload.ReturnTo)));
    }

    /// <summary>Decodes a payload, or returns <see langword="null"/> when it is malformed.</summary>
    public static CalendarOAuthStatePayload? Decode(string? text)
    {
        if (text is null)
        {
            return null;
        }

        var parts = text.Split('\n');
        if (parts.Length != 7
            || !Guid.TryParseExact(parts[1], "D", out var principal)
            || !Guid.TryParseExact(parts[2], "D", out var tenant)
            || !long.TryParse(parts[5], NumberStyles.None, CultureInfo.InvariantCulture, out var issued))
        {
            return null;
        }

        try
        {
            var returnTo = Encoding.UTF8.GetString(Convert.FromBase64String(parts[6]));
            return new CalendarOAuthStatePayload(
                parts[0], tenant, principal, parts[3], parts[4], DateTimeOffset.FromUnixTimeSeconds(issued), ReturnToPath.Sanitize(returnTo));
        }
        catch (FormatException)
        {
            return null;
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether a decoded state may complete: the nonce cookie matches in fixed time, the signed-in
    /// session is the one that started it, the provider in the route is the one it was started
    /// for, and it is at most ten minutes old.
    /// </summary>
    public static bool Accepts(
        CalendarOAuthStatePayload payload,
        string? cookieNonce,
        Guid tenantId,
        Guid principalId,
        string provider,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return FixedEquals(cookieNonce, payload.Nonce)
            && payload.TenantId == tenantId
            && payload.PrincipalId == principalId
            && string.Equals(payload.Provider, provider, StringComparison.Ordinal)
            && payload.Issued <= now + TimeSpan.FromMinutes(1)
            && now - payload.Issued <= Lifetime;
    }

    private static bool FixedEquals(string? left, string right)
    {
        if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right))
        {
            return false;
        }

        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
