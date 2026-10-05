using System.Globalization;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Nix.Features.Speech;

/// <summary>
/// Issues and reads the short-lived capability a browser presents to the speech worker for
/// interactive synthesis and dictation (ADR-0059).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a capability at all.</b> Speaking and dictating cannot wait on a job queue, and audio
/// must not pass through Core. So the browser reaches the speech worker directly, carrying
/// something only Core could have made, and the worker hands it back to Core to learn whose it
/// is. The worker never holds a key that would let it mint or read one itself.
/// </para>
/// <para>
/// <b>What it is.</b> A Data Protection payload under its own purpose, so nothing protected for
/// another feature can be unprotected as one, carrying the tenant, the principal and the single
/// thing it may be used for. Nothing is stored: validity is the key ring's signature, the expiry
/// sealed inside it, and an exact purpose match. That also means it is not single-use and cannot
/// be revoked before it expires, which is why it lives for minutes and names one purpose.
/// </para>
/// <para>
/// <b>What it is not.</b> A session. It says who asked and for what; it carries no permission
/// over any item, and the worker is given none by redeeming it.
/// </para>
/// </remarks>
public sealed class SpeechCapabilityProtector
{
    /// <summary>The Data Protection purpose. Versioned with the payload layout below.</summary>
    public const string ProtectorPurpose = "Nix.Speech.Capability.v1";

    /// <summary>The capability purpose that allows text to be spoken.</summary>
    public const string Synthesize = "synthesize";

    /// <summary>The capability purpose that allows a clip to be transcribed interactively.</summary>
    public const string Dictate = "dictate";

    /// <summary>
    /// The longest token a redeem will look at. A real one is a few hundred characters; anything
    /// much longer is not one, and is refused before any cryptography is spent on it.
    /// </summary>
    public const int MaximumTokenLength = 1024;

    /// <summary>How long a capability lives. Long enough for a slow page, short enough to leak safely.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    private const string PayloadVersion = "v1";
    private readonly ITimeLimitedDataProtector _protector;
    private readonly TimeProvider _clock;

    /// <summary>Creates the protector.</summary>
    /// <param name="provider">The host's key ring.</param>
    /// <param name="clock">Stamps and judges expiry.</param>
    public SpeechCapabilityProtector(IDataProtectionProvider provider, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(provider);
        ArgumentNullException.ThrowIfNull(clock);

        _protector = provider.CreateProtector(ProtectorPurpose).ToTimeLimitedDataProtector();
        _clock = clock;
    }

    /// <summary>Whether <paramref name="purpose"/> is one a capability may carry.</summary>
    public static bool ValidPurpose(string? purpose) => purpose is Synthesize or Dictate;

    /// <summary>Issues a capability for one principal and one purpose.</summary>
    /// <param name="tenantId">The tenant the principal acts in.</param>
    /// <param name="principalId">The principal asking.</param>
    /// <param name="purpose"><see cref="Synthesize"/> or <see cref="Dictate"/>.</param>
    /// <returns>The opaque token and when it stops working.</returns>
    /// <exception cref="ArgumentException"><paramref name="purpose"/> is not a known purpose.</exception>
    public SpeechCapability Issue(Guid tenantId, Guid principalId, string purpose)
    {
        if (!ValidPurpose(purpose))
        {
            throw new ArgumentException("Unknown speech capability purpose.", nameof(purpose));
        }

        // Newline-joined: every field is a canonical GUID or one of two fixed words, so none can
        // contain the separator and there is nothing to escape.
        var payload = string.Join(
            '\n',
            PayloadVersion,
            tenantId.ToString("D", CultureInfo.InvariantCulture),
            principalId.ToString("D", CultureInfo.InvariantCulture),
            purpose);
        var expiresAt = _clock.GetUtcNow().Add(Lifetime);
        return new SpeechCapability(_protector.Protect(payload, expiresAt), expiresAt);
    }

    /// <summary>
    /// Reads a capability, if it is genuine, unexpired and issued for exactly this purpose.
    /// </summary>
    /// <param name="token">The token as presented.</param>
    /// <param name="purpose">The purpose the worker is about to serve.</param>
    /// <returns>
    /// Whose capability it is, or <see langword="null"/>. One answer for every way of being
    /// wrong - malformed, tampered with, expired, another purpose - so a caller probing with
    /// tokens learns nothing about which check it failed.
    /// </returns>
    public SpeechCapabilityGrant? Redeem(string? token, string? purpose)
    {
        if (string.IsNullOrEmpty(token)
            || token.Length > MaximumTokenLength
            || !ValidPurpose(purpose))
        {
            return null;
        }

        string payload;
        DateTimeOffset expiresAt;
        try
        {
            payload = _protector.Unprotect(token, out expiresAt);
        }
        catch (CryptographicException)
        {
            // Not ours, altered, expired by the key ring's clock, or sealed with a key that has
            // since left the ring.
            return null;
        }
        catch (FormatException)
        {
            // Not even base64url.
            return null;
        }

        // The key ring has already refused an expired payload against the system clock. Judged
        // again against the injected one so the lifetime is governed by the same clock that
        // stamped it.
        if (expiresAt <= _clock.GetUtcNow())
        {
            return null;
        }

        var parts = payload.Split('\n');
        if (parts.Length != 4
            || !string.Equals(parts[0], PayloadVersion, StringComparison.Ordinal)
            || !Guid.TryParseExact(parts[1], "D", out var tenantId)
            || !Guid.TryParseExact(parts[2], "D", out var principalId)
            || tenantId == Guid.Empty
            || principalId == Guid.Empty
            || !string.Equals(parts[3], purpose, StringComparison.Ordinal))
        {
            return null;
        }

        return new SpeechCapabilityGrant(tenantId, principalId, expiresAt);
    }
}

/// <summary>A freshly issued speech capability.</summary>
/// <param name="Token">The opaque token the browser presents to the speech worker.</param>
/// <param name="ExpiresAt">When it stops being redeemable.</param>
public sealed record SpeechCapability(string Token, DateTimeOffset ExpiresAt);

/// <summary>Whose capability a redeemed token is.</summary>
/// <param name="TenantId">The tenant it was issued in.</param>
/// <param name="PrincipalId">The principal it was issued to.</param>
/// <param name="ExpiresAt">When it stops being redeemable.</param>
public sealed record SpeechCapabilityGrant(Guid TenantId, Guid PrincipalId, DateTimeOffset ExpiresAt);
