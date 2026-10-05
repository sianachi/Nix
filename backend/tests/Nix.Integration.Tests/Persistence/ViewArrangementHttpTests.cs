using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The arrangement fields ADR-0054 adds to a view - several sorts, collapsed groups, group limits
/// and column summaries - over Core's real <c>PUT</c> and <c>GET /api/v1/items/{id}/views</c>.
/// </summary>
/// <remarks>
/// Over HTTP for the reason <see cref="StructureRuleParityHttpTests"/> gives: the request contracts
/// and their mapping onto the domain are internal to <c>Nix.Api</c>, and this is where a client's
/// JSON - including the nulls a hand-written client can send - meets them.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ViewArrangementHttpTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public ViewArrangementHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

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
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.view-arrangement.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "view-arrangement-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task An_arranged_view_round_trips_and_its_first_sort_is_mirrored_into_sortBy()
    {
        var token = await AccessTokenAsync("view-arrangement-round-trip");
        var itemId = await CreateScratchItemAsync(token);

        const string views = """
            {"views":[{"id":"all","name":"All","kind":"list","columns":["title"],"groupOrder":[],
              "sortBy":"title","sortDescending":false,
              "sorts":[{"property":"due","descending":true},{"property":"title","descending":false}],
              "collapsedGroups":["Done",""],
              "groupLimits":[{"group":"Doing","limit":5}],
              "aggregates":[{"property":"points","function":"sum"}],
              "filters":[{"property":"title","operator":"contains","value":"plan"}]}],
             "default":"all"}
            """;

        using (var put = await SendRawAsync(HttpMethod.Put, $"/api/v1/items/{itemId}/views", token, views))
        {
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        }

        using var get = await SendRawAsync(HttpMethod.Get, $"/api/v1/items/{itemId}/views", token, null);
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        using var body = JsonDocument.Parse(await get.Content.ReadAsStringAsync(Cancellation));
        var view = body.RootElement.GetProperty("views").EnumerateArray().Single();

        // The single-key fields carry the list's first key, not what the request said.
        Assert.Equal("due", view.GetProperty("sortBy").GetString());
        Assert.True(view.GetProperty("sortDescending").GetBoolean());

        var sorts = view.GetProperty("sorts").EnumerateArray().ToArray();
        Assert.Equal(2, sorts.Length);
        Assert.Equal("due", sorts[0].GetProperty("property").GetString());
        Assert.True(sorts[0].GetProperty("descending").GetBoolean());
        Assert.Equal("title", sorts[1].GetProperty("property").GetString());
        Assert.False(sorts[1].GetProperty("descending").GetBoolean());

        Assert.Equal(
            ["Done", ""],
            view.GetProperty("collapsedGroups").EnumerateArray().Select(group => group.GetString()!).ToArray());

        var limit = view.GetProperty("groupLimits").EnumerateArray().Single();
        Assert.Equal("Doing", limit.GetProperty("group").GetString());
        Assert.Equal(5, limit.GetProperty("limit").GetInt32());

        var aggregate = view.GetProperty("aggregates").EnumerateArray().Single();
        Assert.Equal("points", aggregate.GetProperty("property").GetString());
        Assert.Equal("sum", aggregate.GetProperty("function").GetString());

        var filter = view.GetProperty("filters").EnumerateArray().Single();
        Assert.Equal("contains", filter.GetProperty("operator").GetString());
    }

    [Theory]
    [InlineData("\"sorts\":[null]")]
    [InlineData("\"sorts\":[{\"property\":null,\"descending\":true}]")]
    [InlineData("\"groupLimits\":[null]")]
    [InlineData("\"groupLimits\":[{\"group\":null,\"limit\":3}]")]
    [InlineData("\"aggregates\":[null]")]
    [InlineData("\"aggregates\":[{\"property\":null,\"function\":\"sum\"}]")]
    [InlineData("\"aggregates\":[{\"property\":\"points\",\"function\":null}]")]
    [InlineData("\"filters\":[null]")]
    [InlineData("\"filters\":[{\"property\":null,\"operator\":\"equals\",\"value\":\"x\"}]")]
    [InlineData("\"filters\":[{\"property\":\"status\",\"operator\":null,\"value\":\"x\"}]")]
    [InlineData("\"filters\":[{\"property\":\"status\",\"operator\":\"equals\",\"value\":null}]")]
    public async Task A_null_arrangement_or_filter_entry_is_refused_as_invalid_views_not_a_server_error(
        string field)
    {
        var token = await AccessTokenAsync("view-arrangement-null");
        var itemId = await CreateScratchItemAsync(token);

        var views = "{\"views\":[{\"id\":\"all\",\"name\":\"All\",\"kind\":\"list\",\"columns\":[],"
            + "\"groupOrder\":[],\"sortDescending\":false," + field + "}],\"default\":\"all\"}";

        using var put = await SendRawAsync(HttpMethod.Put, $"/api/v1/items/{itemId}/views", token, views);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, put.StatusCode);
        using var body = JsonDocument.Parse(await put.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("views.invalid", body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task A_malformed_arrangement_entry_is_refused_with_its_reason()
    {
        var token = await AccessTokenAsync("view-arrangement-malformed");
        var itemId = await CreateScratchItemAsync(token);

        const string views = """
            {"views":[{"id":"all","name":"All","kind":"list","columns":[],"groupOrder":[],
              "sortDescending":false,"aggregates":[{"property":"points","function":"median"}]}],
             "default":"all"}
            """;

        using var put = await SendRawAsync(HttpMethod.Put, $"/api/v1/items/{itemId}/views", token, views);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, put.StatusCode);
        using var body = JsonDocument.Parse(await put.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("views.invalid", body.RootElement.GetProperty("code").GetString());
        Assert.Contains("median", body.RootElement.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    private async Task<string> CreateScratchItemAsync(string bearer)
    {
        using var created = await SendRawAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            bearer,
            JsonSerializer.Serialize(new
            {
                type = "note",
                title = "View arrangement scratch",
                parentId = M0SchemaSeed.Alpha.ItemId,
            }));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("id").GetString()!;
    }

    private async Task<string> AccessTokenAsync(string name)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, [AccessTokenScopes.Read, AccessTokenScopes.Write], 1),
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

    private async Task<HttpResponseMessage> SendRawAsync(
        HttpMethod method,
        string path,
        string bearer,
        string? jsonBody)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings)
        : WebApplicationFactory<Program>
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
