using System.Buffers.Text;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Authentication;

/// <summary>
/// Mints and describes the short-lived JWTs Core signs for itself when a personal access token is
/// exchanged.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why Core signs tokens at all.</b> The collaboration and media services validate bearer JWTs
/// against a configured list of issuers and never see a database. A personal access token
/// validated only by Core would work against Core and fail everywhere bodies and exports live. So
/// the token itself is never sent past the exchange endpoint: it buys a ten-minute JWT signed
/// here, and Core's issuer joins the services' issuer lists exactly like another identity
/// provider, keys served from <c>/public/v1/auth/jwks</c>.
/// </para>
/// <para>
/// <b>What bounds the ten minutes.</b> Revocation does not wait for expiry on Core's own surface:
/// Core re-checks the token row on every request it authenticates, so a revoked token is refused
/// on its next call. The collaboration service is looser by design - it caches Core's
/// authorization answer per document and re-checks it on a timer (<c>NIX_COLLAB_REAUTH_SECONDS</c>,
/// ~60s by default), so a revoked token already holding a document open keeps write access to it
/// for up to that window. The JWT lifetime bounds how long a client goes between exchanges: short
/// enough that a revoked token's tail is minutes, long enough that an agent session is not
/// spending a database read per request on re-exchanging.
/// </para>
/// <para>
/// <b>ES256, only.</b> One asymmetric algorithm, chosen rather than negotiated: the validator
/// branch that trusts this issuer accepts exactly this algorithm, so there is no algorithm
/// confusion to have. Asymmetric rather than an HMAC because the collaboration and media services
/// must verify without being able to sign.
/// </para>
/// <para>
/// The signing key arrives as a PEM-encoded P-256 private key in configuration. Unconfigured, the
/// exchange endpoint refuses and says which key is missing; nothing else in the system changes,
/// which is what keeps the contract build and the endpoint tests independent of a secret.
/// </para>
/// </remarks>
public sealed class SelfIssuedTokenService : IDisposable
{
    /// <summary>Configuration key for the issuer name minted into <c>iss</c>.</summary>
    public const string IssuerConfigurationKey = "Nix:AccessTokens:Issuer";

    /// <summary>Configuration key for the audience minted into <c>aud</c>.</summary>
    public const string AudienceConfigurationKey = "Nix:AccessTokens:Audience";

    /// <summary>Configuration key for the PEM-encoded P-256 private signing key.</summary>
    public const string SigningKeyConfigurationKey = "Nix:AccessTokens:SigningKeyPem";

    /// <summary>
    /// Configuration key for a file holding the PEM instead. A PEM is multi-line, which an
    /// environment variable carries badly and a mounted secret carries naturally; the inline key
    /// wins when both are set, so a deployment states at most one.
    /// </summary>
    public const string SigningKeyFileConfigurationKey = "Nix:AccessTokens:SigningKeyPemFile";

    /// <summary>Configuration key for the signing key's <c>kid</c>.</summary>
    public const string KeyIdConfigurationKey = "Nix:AccessTokens:KeyId";

    /// <summary>Configuration key for the minted JWT lifetime, in minutes.</summary>
    public const string LifetimeMinutesConfigurationKey = "Nix:AccessTokens:LifetimeMinutes";

    /// <summary>The claim carrying the tenant the token row belongs to.</summary>
    public const string TenantClaim = "nix_tenant_id";

    /// <summary>The claim carrying the token row the session must re-check.</summary>
    public const string AccessTokenClaim = "nix_pat_id";

    private const int DefaultLifetimeMinutes = 10;

    private readonly ECDsa? _key;
    private readonly ECDsaSecurityKey? _securityKey;
    private readonly JwtSecurityTokenHandler _handler = new() { MapInboundClaims = false };

    /// <summary>Initializes a new instance of the <see cref="SelfIssuedTokenService"/> class.</summary>
    /// <param name="configuration">Where the issuer, audience, key and lifetime come from.</param>
    /// <param name="clock">The clock <c>iat</c> and <c>exp</c> are minted from.</param>
    public SelfIssuedTokenService(IConfiguration configuration, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(clock);

        Clock = clock;
        Issuer = configuration[IssuerConfigurationKey] ?? string.Empty;
        Audience = configuration[AudienceConfigurationKey] ?? string.Empty;
        KeyId = configuration[KeyIdConfigurationKey] ?? string.Empty;
        Lifetime = TimeSpan.FromMinutes(
            configuration.GetValue(LifetimeMinutesConfigurationKey, DefaultLifetimeMinutes));

        var pem = configuration[SigningKeyConfigurationKey];
        if (string.IsNullOrWhiteSpace(pem))
        {
            pem = ReadKeyFile(configuration[SigningKeyFileConfigurationKey]);
        }

        if (string.IsNullOrWhiteSpace(Issuer)
            || string.IsNullOrWhiteSpace(Audience)
            || string.IsNullOrWhiteSpace(KeyId)
            || string.IsNullOrWhiteSpace(pem))
        {
            return;
        }

        var key = ECDsa.Create();
        try
        {
            key.ImportFromPem(pem);
        }
        catch (ArgumentException)
        {
            // A malformed key is configuration that looks present and is not. Treated as absent -
            // the exchange endpoint reports itself unconfigured - rather than throwing the host
            // down, for the same reason a missing connection string logs instead of crashing: the
            // contract build starts this host with no secrets at all.
            key.Dispose();
            return;
        }
        catch (CryptographicException)
        {
            key.Dispose();
            return;
        }

        if (key.KeySize != 256)
        {
            // ES256 is P-256 by definition; a curve of any other size would sign tokens the
            // validator refuses, which presents as every exchange succeeding and every request
            // failing. Refusing the key here keeps the failure at the exchange with a clear code.
            key.Dispose();
            return;
        }

        _key = key;
        _securityKey = new ECDsaSecurityKey(key) { KeyId = KeyId };
    }

    /// <summary>Gets the clock the mint stamps from, shared so callers judge expiry consistently.</summary>
    public TimeProvider Clock { get; }

    /// <summary>Gets the issuer name minted into <c>iss</c>, or empty when unconfigured.</summary>
    public string Issuer { get; }

    /// <summary>Gets the audience minted into <c>aud</c>, or empty when unconfigured.</summary>
    public string Audience { get; }

    /// <summary>Gets the signing key's identifier, served in the JWKS and stamped into headers.</summary>
    public string KeyId { get; }

    /// <summary>Gets how long a minted JWT lives.</summary>
    public TimeSpan Lifetime { get; }

    /// <summary>Gets a value indicating whether minting is possible.</summary>
    [MemberNotNullWhen(true, nameof(_securityKey))]
    public bool IsConfigured => _securityKey is not null;

    /// <summary>
    /// Mints the short-lived JWT a valid exchange buys.
    /// </summary>
    /// <param name="principalId">The principal the session resolves directly.</param>
    /// <param name="tenantId">The tenant the session is scoped to.</param>
    /// <param name="accessTokenId">The row every authenticated request re-checks.</param>
    /// <returns>The signed compact JWT.</returns>
    /// <exception cref="InvalidOperationException">The service is not configured.</exception>
    public string Mint(PrincipalId principalId, TenantId tenantId, PersonalAccessTokenId accessTokenId)
    {
        if (principalId.Value == Guid.Empty)
        {
            throw new ArgumentException("The principal identifier cannot be empty.", nameof(principalId));
        }

        if (!IsConfigured)
        {
            throw new InvalidOperationException(
                $"Cannot mint: {SigningKeyConfigurationKey} (and the issuer, audience and key id "
                + "beside it) must be configured first. The exchange endpoint checks IsConfigured "
                + "before calling this.");
        }

        var now = Clock.GetUtcNow();
        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: Audience,
            claims:
            [
                new Claim("sub", principalId.Value.ToString("D", CultureInfo.InvariantCulture)),
                new Claim(TenantClaim, tenantId.Value.ToString("D", CultureInfo.InvariantCulture)),
                new Claim(AccessTokenClaim, accessTokenId.Value.ToString("D", CultureInfo.InvariantCulture)),
                new Claim("jti", Guid.CreateVersion7().ToString("D", CultureInfo.InvariantCulture)),
            ],
            notBefore: now.UtcDateTime,
            expires: (now + Lifetime).UtcDateTime,
            signingCredentials: new SigningCredentials(_securityKey, SecurityAlgorithms.EcdsaSha256));

        return _handler.WriteToken(token);
    }

    /// <summary>
    /// Builds the validation parameters the token validator's self-issuer branch uses.
    /// </summary>
    /// <returns>Parameters accepting exactly this issuer, audience, key and algorithm.</returns>
    /// <exception cref="InvalidOperationException">The service is not configured.</exception>
    public TokenValidationParameters CreateValidationParameters()
    {
        if (!IsConfigured)
        {
            throw new InvalidOperationException(
                "Cannot validate self-issued tokens without the signing key configured. Callers "
                + "check IsConfigured before taking this branch.");
        }

        return new TokenValidationParameters
        {
            ValidIssuer = Issuer,
            ValidAudience = Audience,
            IssuerSigningKey = _securityKey,
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidateLifetime = true,

            // Exactly one algorithm. The list form matters: an empty or absent allowlist would
            // fall back to "whatever the key supports", and this issuer never negotiates.
            ValidAlgorithms = [SecurityAlgorithms.EcdsaSha256],

            ClockSkew = TimeSpan.FromSeconds(30),
        };
    }

    /// <summary>
    /// Reads the two claims a validated self-issued token must carry.
    /// </summary>
    /// <param name="identity">The validated claims.</param>
    /// <param name="tenantId">The tenant claim, parsed.</param>
    /// <param name="accessTokenId">The token-row claim, parsed.</param>
    /// <returns>
    /// Whether both were present and well-formed. A signed token missing either was not minted by
    /// <see cref="Mint"/> and is refused by the caller.
    /// </returns>
    public static bool TryReadClaims(
        ClaimsIdentity identity,
        out TenantId tenantId,
        out PrincipalId principalId,
        out PersonalAccessTokenId accessTokenId)
    {
        ArgumentNullException.ThrowIfNull(identity);

        tenantId = default;
        principalId = default;
        accessTokenId = default;

        if (!Guid.TryParseExact(identity.FindFirst("sub")?.Value, "D", out var principal)
            || !Guid.TryParseExact(identity.FindFirst(TenantClaim)?.Value, "D", out var tenant)
            || !Guid.TryParseExact(identity.FindFirst(AccessTokenClaim)?.Value, "D", out var token)
            || principal == Guid.Empty
            || tenant == Guid.Empty
            || token == Guid.Empty)
        {
            return false;
        }

        tenantId = TenantId.From(tenant);
        principalId = PrincipalId.From(principal);
        accessTokenId = PersonalAccessTokenId.From(token);
        return true;
    }

    /// <summary>
    /// Describes the public half of the signing key, for <c>/public/v1/auth/jwks</c>.
    /// </summary>
    /// <returns>The key set, or an empty one while unconfigured.</returns>
    /// <remarks>
    /// An empty set rather than an error: a service configured to trust this issuer polls the
    /// endpoint, and "no keys yet" is an answer it already knows how to treat as "trust nothing".
    /// </remarks>
    public JwksResponse DescribePublicKeys()
    {
        if (!IsConfigured || _key is null)
        {
            return new JwksResponse([]);
        }

        var parameters = _key.ExportParameters(includePrivateParameters: false);
        return new JwksResponse(
        [
            new JwkResponse(
                Kty: "EC",
                Crv: "P-256",
                X: Base64Url.EncodeToString(parameters.Q.X!),
                Y: Base64Url.EncodeToString(parameters.Q.Y!),
                Kid: KeyId,
                Use: "sig",
                Alg: "ES256"),
        ]);
    }

    /// <inheritdoc />
    public void Dispose() => _key?.Dispose();

    /// <summary>
    /// Reads the key file, treating every failure as "unconfigured".
    /// </summary>
    /// <param name="path">The configured path, possibly absent.</param>
    /// <returns>The file's text, or <see langword="null"/>.</returns>
    /// <remarks>
    /// The same fail-soft reading the malformed-PEM branch gets, for the same reason: the
    /// contract build starts this host with no secrets and no files, and the exchange endpoint is
    /// where "unconfigured" is reported with a code rather than a crash.
    /// </remarks>
    private static string? ReadKeyFile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }
}

/// <summary>An RFC 7517 key set: what <c>/public/v1/auth/jwks</c> serves.</summary>
/// <param name="Keys">The signing keys currently trusted.</param>
public sealed record JwksResponse(IReadOnlyList<JwkResponse> Keys);

/// <summary>One RFC 7517 elliptic-curve public key.</summary>
/// <param name="Kty">The key type: always <c>EC</c>.</param>
/// <param name="Crv">The curve: always <c>P-256</c>.</param>
/// <param name="X">The x coordinate, base64url.</param>
/// <param name="Y">The y coordinate, base64url.</param>
/// <param name="Kid">The key identifier tokens carry in their header.</param>
/// <param name="Use">The intended use: always <c>sig</c>.</param>
/// <param name="Alg">The algorithm: always <c>ES256</c>.</param>
public sealed record JwkResponse(
    string Kty,
    string Crv,
    string X,
    string Y,
    string Kid,
    string Use,
    string Alg);
