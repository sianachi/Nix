using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

public sealed class NixTokenValidatorTests
{
    [Theory]
    [InlineData("api", "service")]
    [InlineData("service", "api")]
    public async Task Provider_key_sets_are_isolated_in_both_cache_orders(
        string firstAudience,
        string secondAudience)
    {
        var issuer = $"https://{firstAudience}-first.issuer.example.test";
        var firstTenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var secondTenant = TenantId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        using var firstRsa = RSA.Create(2048);
        using var secondRsa = RSA.Create(2048);
        var firstKey = SigningKey(firstRsa);
        var secondKey = SigningKey(secondRsa);
        var firstJwksUri = new Uri($"{issuer}/{firstAudience}/keys");
        var secondJwksUri = new Uri($"{issuer}/{secondAudience}/keys");
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [firstAudience] = new(firstTenant, issuer, firstAudience, firstJwksUri, ["RS256"]),
            [secondAudience] = new(secondTenant, issuer, secondAudience, secondJwksUri, ["RS256"]),
        };
        var keySets = new Dictionary<Uri, string>
        {
            [firstJwksUri] = Jwks(firstRsa, firstKey.KeyId),
            [secondJwksUri] = Jwks(secondRsa, secondKey.KeyId),
        };
        using var keyHandler = new JwksHandler(keySets);
        using var keyClient = new HttpClient(keyHandler);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, keyClient);

        var first = await validator.ValidateAsync(
            SignedToken(issuer, firstAudience, firstKey),
            TestContext.Current.CancellationToken);
        var second = await validator.ValidateAsync(
            SignedToken(issuer, secondAudience, secondKey),
            TestContext.Current.CancellationToken);
        var crossTenant = await validator.ValidateAsync(
            SignedToken(issuer, secondAudience, firstKey),
            TestContext.Current.CancellationToken);

        Assert.Equal(firstTenant, Assert.IsType<ValidatedToken>(first).TenantId);
        Assert.Equal(secondTenant, Assert.IsType<ValidatedToken>(second).TenantId);
        Assert.Null(crossTenant);
        Assert.Equal(1, keyHandler.Requests[firstJwksUri]);
        Assert.Equal(1, keyHandler.Requests[secondJwksUri]);
    }

    [Theory]
    [InlineData("api,service")]
    [InlineData("service,api")]
    public async Task Cross_tenant_audiences_are_refused_regardless_of_claim_order(string ordered)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        var audiences = ordered.Split(',');
        var directory = new AmbiguousDirectory(audiences);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(directory, selfIssued);

        var result = await validator.ValidateAsync(Token(audiences), TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal(audiences, directory.Lookups);
    }

    [Theory]
    [InlineData("api,service")]
    [InlineData("service,api")]
    public async Task Audiences_for_one_provider_are_coalesced_regardless_of_claim_order(string ordered)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        var audiences = ordered.Split(',');
        var issuer = $"https://same-provider-{audiences[0]}.issuer.example.test";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var rsa = RSA.Create(2048);
        var key = SigningKey(rsa);
        var registrations = audiences.ToDictionary(
            audience => audience,
            audience => new IdentityProviderRegistration(
                tenant,
                issuer,
                audience,
                jwksUri,
                ["RS256"]),
            StringComparer.Ordinal);
        using var keyHandler = new JwksHandler(
            new Dictionary<Uri, string> { [jwksUri] = Jwks(rsa, key.KeyId) });
        using var keyClient = new HttpClient(keyHandler);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, keyClient);

        var result = await validator.ValidateAsync(
            SignedToken(issuer, audiences, key),
            TestContext.Current.CancellationToken);

        var validated = Assert.IsType<ValidatedToken>(result);
        Assert.Equal(tenant, validated.TenantId);
        Assert.Contains(validated.Registration!.Audience, audiences);
        Assert.Equal(1, keyHandler.Requests[jwksUri]);
    }

    [Fact]
    public async Task Concurrent_unknown_key_ids_trigger_one_provider_refresh()
    {
        var issuer = $"https://single-flight-{Guid.NewGuid():N}.issuer.example.test";
        var audience = "api";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var knownRsa = RSA.Create(2048);
        using var unknownRsa = RSA.Create(2048);
        var knownKey = SigningKey(knownRsa);
        var unknownKey = new RsaSecurityKey(unknownRsa) { KeyId = "unknown-key-id" };
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [audience] = new(tenant, issuer, audience, jwksUri, ["RS256"]),
        };
        using var handler = new MutableJwksHandler(Jwks(knownRsa, knownKey.KeyId));
        using var client = new HttpClient(handler);
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, client, clock);

        Assert.NotNull(await validator.ValidateAsync(
            SignedToken(issuer, audience, knownKey),
            TestContext.Current.CancellationToken));
        clock.Advance(TimeSpan.FromMinutes(6));

        var attempts = Enumerable.Range(0, 32)
            .Select(_ => validator.ValidateAsync(
                SignedToken(issuer, audience, unknownKey),
                TestContext.Current.CancellationToken).AsTask())
            .ToArray();
        Assert.All(await Task.WhenAll(attempts), Assert.Null);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task Failed_unknown_key_refresh_is_single_flight_and_backed_off()
    {
        var issuer = $"https://failure-backoff-{Guid.NewGuid():N}.issuer.example.test";
        var audience = "api";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var knownRsa = RSA.Create(2048);
        using var unknownRsa = RSA.Create(2048);
        var knownKey = SigningKey(knownRsa);
        var unknownKey = new RsaSecurityKey(unknownRsa) { KeyId = "unknown-failure-key-id" };
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [audience] = new(tenant, issuer, audience, jwksUri, ["RS256"]),
        };
        using var handler = new MutableJwksHandler(Jwks(knownRsa, knownKey.KeyId));
        using var client = new HttpClient(handler);
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, client, clock);

        Assert.NotNull(await validator.ValidateAsync(
            SignedToken(issuer, audience, knownKey),
            TestContext.Current.CancellationToken));
        handler.Fail = true;
        clock.Advance(TimeSpan.FromMinutes(6));

        var attempts = Enumerable.Range(0, 32)
            .Select(_ => validator.ValidateAsync(
                SignedToken(issuer, audience, unknownKey),
                TestContext.Current.CancellationToken).AsTask())
            .ToArray();
        Assert.All(await Task.WhenAll(attempts), Assert.Null);
        Assert.Null(await validator.ValidateAsync(
            SignedToken(issuer, audience, unknownKey),
            TestContext.Current.CancellationToken));
        Assert.Equal(2, handler.Requests);
    }

    private static string Token(IReadOnlyList<string> audiences)
    {
        var payload = new JwtPayload
        {
            ["iss"] = "https://issuer.example.test",
            ["aud"] = audiences,
            ["sub"] = "subject",
            ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(),
        };
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(new JwtHeader(), payload));
    }

    private static RsaSecurityKey SigningKey(RSA rsa) =>
        new(rsa) { KeyId = "shared-key-id" };

    private static string SignedToken(string issuer, string audience, SecurityKey key)
    {
        var token = new JwtSecurityToken(
            issuer,
            audience,
            [new Claim("sub", "subject")],
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5),
            new SigningCredentials(key, SecurityAlgorithms.RsaSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string SignedToken(
        string issuer,
        IReadOnlyList<string> audiences,
        SecurityKey key)
    {
        var payload = new JwtPayload(
            issuer,
            null,
            [new Claim("sub", "subject")],
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5))
        {
            ["aud"] = audiences,
        };
        return new JwtSecurityTokenHandler().WriteToken(
            new JwtSecurityToken(new JwtHeader(new SigningCredentials(key, SecurityAlgorithms.RsaSha256)), payload));
    }

    private static string Jwks(RSA rsa, string keyId)
    {
        var parameters = rsa.ExportParameters(includePrivateParameters: false);
        return JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new
                {
                    kty = "RSA",
                    use = "sig",
                    kid = keyId,
                    alg = "RS256",
                    n = Base64UrlEncoder.Encode(parameters.Modulus),
                    e = Base64UrlEncoder.Encode(parameters.Exponent),
                },
            },
        });
    }

    private sealed class AmbiguousDirectory(IReadOnlyList<string> accepted) : IIdentityDirectory
    {
        private readonly HashSet<string> _accepted = accepted.ToHashSet(StringComparer.Ordinal);
        private readonly List<string> _lookups = [];

        internal IReadOnlyList<string> Lookups => _lookups;

        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken)
        {
            _lookups.Add(audience);
            var tenantId = audience == accepted[0]
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222";
            return ValueTask.FromResult<IdentityProviderRegistration?>(_accepted.Contains(audience)
                ? new IdentityProviderRegistration(
                    TenantId.From(Guid.Parse(tenantId)),
                    issuer,
                    audience,
                    new Uri("https://issuer.example.test/keys"),
                    ["RS256"])
                : null);
        }

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalAsync(
            TenantId tenantId,
            string externalSubject,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);
    }

    // These tests exercise the registered-issuer path, where Core's own self-issuer is never
    // reached: an unconfigured SelfIssuedTokenService reports IsConfigured false, so the self-issuer
    // branch is skipped and every token routes through the identity_provider resolution under test.
    private static SelfIssuedTokenService Unconfigured() =>
        new(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), TimeProvider.System);

    private sealed class RegistrationDirectory(
        IReadOnlyDictionary<string, IdentityProviderRegistration> registrations) : IIdentityDirectory
    {
        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(
                registrations.TryGetValue(audience, out var registration)
                    && string.Equals(registration.Issuer, issuer, StringComparison.Ordinal)
                    ? registration
                    : null);

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalAsync(
            TenantId tenantId,
            string externalSubject,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);
    }

    private sealed class JwksHandler(IReadOnlyDictionary<Uri, string> keySets) : HttpMessageHandler
    {
        internal Dictionary<Uri, int> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = Assert.IsType<Uri>(request.RequestUri);
            Requests[uri] = Requests.GetValueOrDefault(uri) + 1;
            return Task.FromResult(keySets.TryGetValue(uri, out var keySet)
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(keySet, Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private sealed class MutableJwksHandler(string keySet) : HttpMessageHandler
    {
        private int _requests;

        internal bool Fail { get; set; }

        internal int Requests => Volatile.Read(ref _requests);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requests);
            return Task.FromResult(Fail
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(keySet, Encoding.UTF8, "application/json"),
                });
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset _now = initial;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan elapsed) => _now += elapsed;
    }
}
