using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The speech capability path (ADR-0059) through the real pipeline: a bearer mints, and the
/// internal secret alone - no session, no job - redeems.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SpeechCapabilityHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "speech-http-internal-secret";
    private const string RedeemRoute = "/internal/worker-dispatch/speech/capabilities/redeem";
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public SpeechCapabilityHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.speech-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "speech-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Theory]
    [InlineData("synthesize", "dictate")]
    [InlineData("dictate", "synthesize")]
    public async Task A_capability_redeems_for_its_own_purpose_and_no_other(string purpose, string otherPurpose)
    {
        var bearer = await AccessTokenAsync(TestTenants.AlphaContext);
        var before = DateTimeOffset.UtcNow;

        using var create = await SendAsync("/api/v1/speech/capabilities", bearer, new { purpose });

        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        using var created = JsonDocument.Parse(await create.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(2, created.RootElement.EnumerateObject().Count());
        var token = created.RootElement.GetProperty("token").GetString();
        var expiresAt = created.RootElement.GetProperty("expiresAt").GetDateTimeOffset();
        Assert.False(string.IsNullOrEmpty(token));
        Assert.InRange(expiresAt, before.AddMinutes(4), before.AddMinutes(6));

        // Only the internal secret: no bearer, no job or execution headers.
        using (var redeem = await RedeemAsync(new { token, purpose }))
        {
            Assert.Equal(HttpStatusCode.OK, redeem.StatusCode);
            using var grant = JsonDocument.Parse(await redeem.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(3, grant.RootElement.EnumerateObject().Count());
            Assert.Equal(TestTenants.Alpha, grant.RootElement.GetProperty("tenantId").GetGuid());
            Assert.Equal(TestTenants.AlphaPrincipal, grant.RootElement.GetProperty("principalId").GetGuid());
            Assert.Equal(expiresAt, grant.RootElement.GetProperty("expiresAt").GetDateTimeOffset());
        }

        using (var wrongPurpose = await RedeemAsync(new { token, purpose = otherPurpose }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, wrongPurpose.StatusCode);
            Assert.Equal("speech.capability_refused", await ProblemCodeAsync(wrongPurpose));
        }

        // Not single-use: nothing is stored, so the same token redeems again until it expires.
        using var again = await RedeemAsync(new { token, purpose });
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    [Fact]
    public async Task Each_tenant_s_capability_names_its_own_principal()
    {
        var beta = await AccessTokenAsync(TestTenants.BetaContext);
        using var create = await SendAsync("/api/v1/speech/capabilities", beta, new { purpose = "dictate" });
        create.EnsureSuccessStatusCode();
        using var created = JsonDocument.Parse(await create.Content.ReadAsStringAsync(Cancellation));
        var token = created.RootElement.GetProperty("token").GetString();

        using var redeem = await RedeemAsync(new { token, purpose = "dictate" });

        redeem.EnsureSuccessStatusCode();
        using var grant = JsonDocument.Parse(await redeem.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(TestTenants.Beta, grant.RootElement.GetProperty("tenantId").GetGuid());
        Assert.Equal(TestTenants.BetaPrincipal, grant.RootElement.GetProperty("principalId").GetGuid());
    }

    [Fact]
    public async Task Everything_that_is_not_a_valid_capability_gets_the_same_refusal()
    {
        var bearer = await AccessTokenAsync(TestTenants.AlphaContext);
        using var create = await SendAsync("/api/v1/speech/capabilities", bearer, new { purpose = "synthesize" });
        create.EnsureSuccessStatusCode();
        using var created = JsonDocument.Parse(await create.Content.ReadAsStringAsync(Cancellation));
        var token = created.RootElement.GetProperty("token").GetString()!;
        var tampered = string.Concat(token.AsSpan(0, token.Length / 2), token[token.Length / 2] == 'A' ? "B" : "A", token.AsSpan((token.Length / 2) + 1));

        var refusals = new List<string>();
        foreach (var body in new object[]
        {
            new { token = "garbage", purpose = "synthesize" },
            new { token = tampered, purpose = "synthesize" },
            new { token = new string('A', 5000), purpose = "synthesize" },
            new { token = string.Empty, purpose = "synthesize" },
            new { token, purpose = "dictate" },
            new { token, purpose = "everything" },
            new { purpose = "synthesize" },
            new { token },

            // The user's own bearer is not a capability.
            new { token = bearer, purpose = "synthesize" },
        })
        {
            using var refused = await RedeemAsync(body);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            refusals.Add(await StableProblemAsync(refused));
        }

        // Identical in code, title and detail: nothing says which check failed.
        Assert.Single(refusals.Distinct(StringComparer.Ordinal));
        Assert.Contains("speech.capability_refused", refusals[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task Redeeming_needs_the_internal_secret_and_minting_needs_a_bearer_with_write()
    {
        var bearer = await AccessTokenAsync(TestTenants.AlphaContext);
        using var create = await SendAsync("/api/v1/speech/capabilities", bearer, new { purpose = "synthesize" });
        create.EnsureSuccessStatusCode();
        using var created = JsonDocument.Parse(await create.Content.ReadAsStringAsync(Cancellation));
        var token = created.RootElement.GetProperty("token").GetString();

        // The internal surface does not admit it exists to a caller without the secret, and a
        // user's bearer is no substitute for it.
        using (var noSecret = await RedeemAsync(new { token, purpose = "synthesize" }, secret: null))
        {
            Assert.Equal(HttpStatusCode.NotFound, noSecret.StatusCode);
        }
        using (var wrongSecret = await RedeemAsync(new { token, purpose = "synthesize" }, secret: "not-the-secret"))
        {
            Assert.Equal(HttpStatusCode.NotFound, wrongSecret.StatusCode);
        }
        using (var bearerOnly = await RedeemAsync(new { token, purpose = "synthesize" }, secret: null, bearer: bearer))
        {
            Assert.Equal(HttpStatusCode.NotFound, bearerOnly.StatusCode);
        }

        using (var anonymous = await _client.PostAsJsonAsync("/api/v1/speech/capabilities", new { purpose = "synthesize" }, Cancellation))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        }
        var readOnly = await AccessTokenAsync(TestTenants.AlphaContext, AccessTokenScopes.Read);
        using (var underScoped = await SendAsync("/api/v1/speech/capabilities", readOnly, new { purpose = "synthesize" }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, underScoped.StatusCode);
            Assert.Equal("auth.insufficient_scope", await ProblemCodeAsync(underScoped));
        }
        using (var badPurpose = await SendAsync("/api/v1/speech/capabilities", bearer, new { purpose = "sing" }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, badPurpose.StatusCode);
            Assert.Equal("speech.invalid", await ProblemCodeAsync(badPurpose));
        }
    }

    [Fact]
    public async Task The_redeem_exchange_has_exactly_the_shape_of_the_shared_worker_fixtures()
    {
        var request = Fixture("s1_redeem_request.json");
        var purpose = request.GetProperty("purpose").GetString();
        var bearer = await AccessTokenAsync(TestTenants.AlphaContext);
        using var create = await SendAsync("/api/v1/speech/capabilities", bearer, new { purpose });
        create.EnsureSuccessStatusCode();
        using var created = JsonDocument.Parse(await create.Content.ReadAsStringAsync(Cancellation));

        // The fixture's own members, in its own order, with only the token made real.
        var body = new System.Text.Json.Nodes.JsonObject();
        foreach (var member in request.EnumerateObject())
        {
            body[member.Name] = member.Name == "token"
                ? created.RootElement.GetProperty("token").GetString()
                : System.Text.Json.Nodes.JsonNode.Parse(member.Value.GetRawText());
        }
        Assert.Equal(["token", "purpose"], body.Select(member => member.Key));

        using var message = new HttpRequestMessage(HttpMethod.Post, RedeemRoute);
        message.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        message.Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json");
        using var redeem = await _client.SendAsync(message, Cancellation);

        Assert.Equal(HttpStatusCode.OK, redeem.StatusCode);
        using var grant = JsonDocument.Parse(await redeem.Content.ReadAsStringAsync(Cancellation));
        AssertSameShape(Fixture("s1_redeem_response.json"), grant.RootElement);
        Assert.Equal(TestTenants.Alpha, grant.RootElement.GetProperty("tenantId").GetGuid());
        Assert.Equal(TestTenants.AlphaPrincipal, grant.RootElement.GetProperty("principalId").GetGuid());
        Assert.True(grant.RootElement.GetProperty("expiresAt").TryGetDateTimeOffset(out _));

        // The fixture's placeholder token, verbatim, is of course nobody's capability.
        using var placeholder = new HttpRequestMessage(HttpMethod.Post, RedeemRoute);
        placeholder.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        placeholder.Content = new StringContent(FixtureText("s1_redeem_request.json"), System.Text.Encoding.UTF8, "application/json");
        using var refused = await _client.SendAsync(placeholder, Cancellation);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
    }

    private async Task<HttpResponseMessage> SendAsync(string path, string bearer, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Content = JsonContent.Create(body);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<HttpResponseMessage> RedeemAsync(object body, string? secret = InternalSecret, string? bearer = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, RedeemRoute);
        if (secret is not null)
        {
            request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, secret);
        }
        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }
        request.Content = JsonContent.Create(body);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<string> AccessTokenAsync(NixSessionContext principal, params string[] scopes)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(principal, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                "speech-http",
                scopes.Length == 0 ? [AccessTokenScopes.Read, AccessTokenScopes.Write] : scopes,
                1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    /// <summary>
    /// The same member names and, member for member, the same JSON value kind as the fixture the
    /// Go worker's own tests assert byte for byte.
    /// </summary>
    private static void AssertSameShape(JsonElement expected, JsonElement actual)
    {
        Assert.Equal(
            expected.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal),
            actual.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal));
        foreach (var member in expected.EnumerateObject())
        {
            Assert.True(
                member.Value.ValueKind == actual.GetProperty(member.Name).ValueKind,
                $"'{member.Name}' is {actual.GetProperty(member.Name).ValueKind}, the fixture has {member.Value.ValueKind}.");
        }
    }

    private static JsonElement Fixture(string name)
    {
        using var document = JsonDocument.Parse(FixtureText(name));
        return document.RootElement.Clone();
    }

    private static string FixtureText(string name) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "apps", "go-workers", "internal", "workerapi", "testdata", "speech", name));

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException($"No Nix.slnx above {AppContext.BaseDirectory}.");
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }

    /// <summary>The parts of a problem that do not vary per request (no trace or request id).</summary>
    private static async Task<string> StableProblemAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var root = document.RootElement;
        return string.Join(
            '|',
            root.GetProperty("status").GetInt32(),
            root.GetProperty("code").GetString(),
            root.GetProperty("title").GetString(),
            root.GetProperty("detail").GetString());
    }

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
        }
    }
}
