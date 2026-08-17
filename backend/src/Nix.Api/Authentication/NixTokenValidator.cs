using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Domain.Tenancy;

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
/// Signing keys are fetched from the registered provider's JWKS endpoint and cached per immutable
/// registration identity, with refresh and key rollover handled here rather than by a configuration
/// manager: the registration stores the JWKS endpoint directly, so there is no discovery document
/// to manage. See <see cref="KeyLifetime"/> for how long a key set is trusted and
/// <see cref="MinimumRefetchInterval"/> for the floor that keeps a rotation refetch from becoming a
/// fetch storm. Without the cache every request would fetch a key set, which is both slow and a way
/// to have the identity provider rate-limit us out of service.
/// </para>
/// </remarks>
public sealed class NixTokenValidator
{
    private const int MaximumAudiences = 16;

    private readonly IIdentityDirectory _directory;
    private readonly HttpClient _keyFetcher;
    private readonly TimeProvider _clock;
    // MapInboundClaims off, deliberately. The handler's legacy default rewrites standard JWT claim
    // names into WS-Federation URIs - `sub` becomes ...claims/nameidentifier - so a lookup for
    // "sub" silently finds nothing and every token is refused with no error to explain it.
    private readonly JwtSecurityTokenHandler _handler = new() { MapInboundClaims = false };

    // Keyed by the complete immutable provider registration identity, not issuer alone. One issuer
    // can legitimately register separate audiences and JWKS sets for separate tenants. Reusing one
    // audience's set for another would become a cross-tenant acceptance bug when both sets contain
    // the same kid.
    private static readonly ConcurrentDictionary<ProviderCacheKey, ProviderCacheState> KeyCache = [];

    private static readonly HttpClient DefaultKeyFetcher = new() { Timeout = TimeSpan.FromSeconds(10) };

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

    private sealed class ProviderCacheState
    {
        internal object Sync { get; } = new();

        internal SemaphoreSlim Refresh { get; } = new(1, 1);

        internal CachedKeySet? Cached { get; set; }

        internal DateTimeOffset LastAttempt { get; set; } = DateTimeOffset.MinValue;
    }

    private readonly record struct ProviderCacheKey(
        TenantId TenantId,
        string Issuer,
        string Audience,
        Uri JwksUri);

    /// <summary>Initializes a new instance of the <see cref="NixTokenValidator"/> class.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    public NixTokenValidator(IIdentityDirectory directory)
        : this(directory, DefaultKeyFetcher, TimeProvider.System)
    {
    }

    /// <summary>Initializes a validator with a specific signing-key client.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    /// <param name="keyFetcher">The client used to retrieve registered JWKS documents.</param>
    public NixTokenValidator(IIdentityDirectory directory, HttpClient keyFetcher)
        : this(directory, keyFetcher, TimeProvider.System)
    {
    }

    /// <summary>Initializes a validator with explicit signing-key I/O and time.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    /// <param name="keyFetcher">The client used to retrieve registered JWKS documents.</param>
    /// <param name="clock">The time source used for refresh and failure backoff.</param>
    public NixTokenValidator(IIdentityDirectory directory, HttpClient keyFetcher, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(keyFetcher);
        ArgumentNullException.ThrowIfNull(clock);
        _directory = directory;
        _keyFetcher = keyFetcher;
        _clock = clock;
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
        var audiences = unverified.Audiences
            .Where(static audience => !string.IsNullOrWhiteSpace(audience))
            .Distinct(StringComparer.Ordinal)
            .Take(MaximumAudiences + 1)
            .ToArray();

        if (string.IsNullOrWhiteSpace(issuer)
            || audiences.Length is 0 or > MaximumAudiences)
        {
            return null;
        }

        IdentityProviderRegistration? registration = null;
        foreach (var audience in audiences)
        {
            var candidate = await _directory
                .ResolveProviderAsync(issuer, audience, cancellationToken)
                .ConfigureAwait(false);
            if (candidate is null)
            {
                continue;
            }

            // A token can legitimately carry both the web-client and project audiences. They are
            // one provider match when every validation-policy field is identical; the selected
            // audience only gives TokenValidationParameters one of the token's accepted values.
            // Different tenants, key sets, or algorithms remain ambiguous and fail closed, so
            // attacker-controlled audience order can never select a different validation policy.
            if (registration is not null && !SameProviderPolicy(registration, candidate))
            {
                return null;
            }

            registration ??= candidate;
        }

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

    private static bool SameProviderPolicy(
        IdentityProviderRegistration first,
        IdentityProviderRegistration second) =>
        first.TenantId == second.TenantId
        && string.Equals(first.Issuer, second.Issuer, StringComparison.Ordinal)
        && first.JwksUri == second.JwksUri
        && first.AllowedAlgorithms.ToHashSet(StringComparer.Ordinal)
            .SetEquals(second.AllowedAlgorithms);

    private async ValueTask<ICollection<SecurityKey>?> ResolveSigningKeysAsync(
        IdentityProviderRegistration registration,
        string? keyId,
        CancellationToken cancellationToken)
    {
        var now = _clock.GetUtcNow();
        var cacheKey = new ProviderCacheKey(
            registration.TenantId,
            registration.Issuer,
            registration.Audience,
            registration.JwksUri);

        var state = KeyCache.GetOrAdd(cacheKey, static _ => new ProviderCacheState());
        CachedKeySet? cached;
        DateTimeOffset lastAttempt;
        lock (state.Sync)
        {
            cached = state.Cached;
            lastAttempt = state.LastAttempt;
        }

        if (cached is not null)
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
            if (!knowsKey && now - lastAttempt < MinimumRefetchInterval)
            {
                return cached.Keys.GetSigningKeys();
            }
        }

        await state.Refresh.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            // Another request may have completed the refresh while this one waited. Re-evaluate
            // both success freshness and failure backoff under the provider's single-flight gate.
            now = _clock.GetUtcNow();
            lock (state.Sync)
            {
                cached = state.Cached;
                lastAttempt = state.LastAttempt;
            }
            if (cached is not null)
            {
                var knowsKey = keyId is null
                    || cached.Keys.Keys.Any(key => string.Equals(key.Kid, keyId, StringComparison.Ordinal));
                if (now - cached.FetchedAt < KeyLifetime && knowsKey)
                {
                    return cached.Keys.GetSigningKeys();
                }

                if (!knowsKey && now - lastAttempt < MinimumRefetchInterval)
                {
                    return cached.Keys.GetSigningKeys();
                }
            }
            else if (now - lastAttempt < MinimumRefetchInterval)
            {
                return null;
            }

            lock (state.Sync)
            {
                state.LastAttempt = now;
            }
            var json = await _keyFetcher
                .GetStringAsync(registration.JwksUri, cancellationToken)
                .ConfigureAwait(false);

            var keySet = new JsonWebKeySet(json);
            lock (state.Sync)
            {
                state.Cached = new CachedKeySet(keySet, now);
            }
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
        finally
        {
            state.Refresh.Release();
        }
    }
}

/// <summary>A token that validated, and what it says.</summary>
/// <param name="Registration">The issuer registration it validated against.</param>
/// <param name="Subject">The issuer's stable subject claim.</param>
public sealed record ValidatedToken(IdentityProviderRegistration Registration, string Subject);
