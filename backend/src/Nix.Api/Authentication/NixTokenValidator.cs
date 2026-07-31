using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.IdentityModel.Tokens.Jwt;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;

namespace Nix.Authentication;

/// <summary>
/// Validates a bearer token against the issuer that a tenant registered for it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Multi-issuer, so the order is unusual and deliberate.</b> A conventional handler is
/// configured with one authority and validates against it. Here the issuer is per-tenant data, so
/// the token has to be read before it can be validated: its <c>iss</c> and <c>aud</c> are looked up
/// in <c>identity_provider</c>, and only a registration that matches both, and is enabled, produces
/// the signing keys the signature is then checked against.
/// </para>
/// <para>
/// Reading claims before validating them is normally a mistake, so it is worth being precise about
/// what is trusted at each step: the unvalidated read is used <i>only</i> to choose which issuer to
/// validate against, and that choice can only ever select a registration an administrator already
/// created. A forged <c>iss</c> selects nothing and the token is refused. Nothing else about the
/// token is believed until the signature checks out.
/// </para>
/// <para>
/// Signing keys are fetched from the issuer's JWKS endpoint and cached per issuer, with refresh and
/// key rollover handled here rather than by a configuration manager: the registration stores the
/// JWKS endpoint directly, so there is no discovery document to manage. See <see cref="KeyLifetime"/>
/// for how long a key set is trusted and <see cref="MinimumRefetchInterval"/> for the floor that
/// keeps a rotation refetch from becoming a fetch storm. Without the cache every request would fetch
/// a key set, which is both slow and a way to have the identity provider rate-limit us out of
/// service.
/// </para>
/// </remarks>
[SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    // Justification: DI-activated. The analyser sees no `new`, because there is none to see - the
    // container builds it. Making it public to dodge the rule would widen the assembly's surface
    // for a diagnostic that is simply wrong here.
    Justification = "Constructed by the framework, not by application code.")]
internal sealed class NixTokenValidator
{
    private readonly IIdentityDirectory _directory;
    // MapInboundClaims off, deliberately. The handler's legacy default rewrites standard JWT claim
    // names into WS-Federation URIs - `sub` becomes ...claims/nameidentifier - so a lookup for
    // "sub" silently finds nothing and every token is refused with no error to explain it.
    private readonly JwtSecurityTokenHandler _handler = new() { MapInboundClaims = false };

    // Keyed by issuer. The registration stores the JWKS endpoint directly, so the key set is
    // fetched from it rather than discovered - pointing an OpenID discovery retriever at a JWKS URL
    // yields a document with no signing keys, which presents as every token being refused with
    // nothing logged, because there is no error to log.
    private static readonly ConcurrentDictionary<string, CachedKeySet> KeyCache =
        new(StringComparer.Ordinal);

    private static readonly HttpClient KeyFetcher = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>How long a key set is trusted before it is fetched again.</summary>
    /// <remarks>
    /// A cache with no expiry is a correctness and a security problem, not just a staleness one.
    /// An issuer that rotates its signing keys would break every token until this process was
    /// restarted, and a key withdrawn because it leaked would go on being trusted for exactly as
    /// long as the process lived. Twelve hours bounds both without making the identity provider
    /// serve a key set per request.
    /// </remarks>
    private static readonly TimeSpan KeyLifetime = TimeSpan.FromHours(12);

    /// <summary>
    /// Shortest gap between refetches triggered by an unknown key id.
    /// </summary>
    /// <remarks>
    /// A token signed with a key we have not seen is the signal that a rotation happened, so it is
    /// worth refetching immediately rather than waiting out the lifetime. Rate-limited because the
    /// same signal is what a flood of forged tokens with random key ids would produce, and that
    /// must not turn into a fetch storm against the issuer.
    /// </remarks>
    private static readonly TimeSpan MinimumRefetchInterval = TimeSpan.FromMinutes(5);

    private sealed record CachedKeySet(JsonWebKeySet Keys, DateTimeOffset FetchedAt);

    /// <summary>Initializes a new instance of the <see cref="NixTokenValidator"/> class.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    public NixTokenValidator(IIdentityDirectory directory)
    {
        ArgumentNullException.ThrowIfNull(directory);
        _directory = directory;
    }

    /// <summary>
    /// Validates a token and reports which tenant and subject it belongs to.
    /// </summary>
    /// <param name="token">The raw bearer token.</param>
    /// <param name="cancellationToken">Cancels the validation.</param>
    /// <returns>
    /// The registration and subject, or <see langword="null"/> when the token is unreadable, comes
    /// from an unregistered issuer, or fails signature or lifetime validation. Every one of those
    /// is the same answer to the caller - refused - because telling them apart would tell an
    /// attacker which part of a forged token to fix.
    /// </returns>
    public async ValueTask<ValidatedToken?> ValidateAsync(string token, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);

        if (!_handler.CanReadToken(token))
        {
            return null;
        }

        // Unvalidated, and used only to choose an issuer to validate against. See the note above.
        var unverified = _handler.ReadJwtToken(token);
        var issuer = unverified.Issuer;
        var audience = unverified.Audiences.FirstOrDefault();

        if (string.IsNullOrWhiteSpace(issuer) || string.IsNullOrWhiteSpace(audience))
        {
            return null;
        }

        var registration = await _directory
            .ResolveProviderAsync(issuer, audience, cancellationToken)
            .ConfigureAwait(false);

        if (registration is null)
        {
            // An unregistered issuer is refused outright and never just-in-time mapped to a tenant.
            return null;
        }

        var keys = await ResolveSigningKeysAsync(registration, unverified.Header.Kid, cancellationToken)
            .ConfigureAwait(false);
        if (keys is null)
        {
            return null;
        }

        var parameters = new TokenValidationParameters
        {
            ValidIssuer = registration.Issuer,
            ValidAudience = registration.Audience,
            IssuerSigningKeys = keys,
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidateLifetime = true,

            // The allowlist is per-registration, so an issuer trusted for RS256 cannot present a
            // token signed some other way. An empty allowlist accepts nothing, which is the correct
            // reading of "no algorithm is permitted".
            ValidAlgorithms = registration.AllowedAlgorithms,

            // Five minutes of default clock skew is generous for tokens that live five to fifteen.
            ClockSkew = TimeSpan.FromSeconds(30),
        };

        try
        {
            var result = await _handler.ValidateTokenAsync(token, parameters).ConfigureAwait(false);
            if (!result.IsValid)
            {
                return null;
            }

            var subject = result.ClaimsIdentity.FindFirst("sub")?.Value;
            return string.IsNullOrWhiteSpace(subject)
                ? null
                : new ValidatedToken(registration, subject);
        }
        catch (SecurityTokenException)
        {
            // An invalid token is an expected outcome on a public endpoint, not an exceptional one.
            return null;
        }
    }

    private static async ValueTask<ICollection<SecurityKey>?> ResolveSigningKeysAsync(
        IdentityProviderRegistration registration,
        string? keyId,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;

        if (KeyCache.TryGetValue(registration.Issuer, out var cached))
        {
            var age = now - cached.FetchedAt;
            var knowsKey = keyId is null
                || cached.Keys.Keys.Any(key => string.Equals(key.Kid, keyId, StringComparison.Ordinal));

            // Fresh enough, and it can verify the token in hand: use it.
            if (age < KeyLifetime && knowsKey)
            {
                return cached.Keys.GetSigningKeys();
            }

            // An unknown key id usually means the issuer rotated. Refetch - but not more often
            // than the floor, so forged tokens carrying random key ids cannot become a fetch
            // storm against the identity provider.
            if (!knowsKey && age < MinimumRefetchInterval)
            {
                return cached.Keys.GetSigningKeys();
            }
        }

        try
        {
            var json = await KeyFetcher
                .GetStringAsync(registration.JwksUri, cancellationToken)
                .ConfigureAwait(false);

            var keySet = new JsonWebKeySet(json);
            KeyCache[registration.Issuer] = new CachedKeySet(keySet, now);
            return keySet.GetSigningKeys();
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or ArgumentException)
        {
            // The issuer's key endpoint is unreachable or malformed.
            //
            // Fall back to a cached set only while it is still inside its lifetime: a brief outage
            // should not sign everybody out, but a key set old enough to have expired must not be
            // kept alive indefinitely by the endpoint staying down. Past that, refuse - accepting
            // a token we cannot verify is worse than a failed request.
            return cached is not null && now - cached.FetchedAt < KeyLifetime
                ? cached.Keys.GetSigningKeys()
                : null;
        }
    }
}

/// <summary>A token that validated, and what it says.</summary>
/// <param name="Registration">The issuer registration it validated against.</param>
/// <param name="Subject">The issuer's stable subject claim.</param>
internal sealed record ValidatedToken(IdentityProviderRegistration Registration, string Subject);
