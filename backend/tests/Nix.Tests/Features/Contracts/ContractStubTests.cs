using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Nix.Tests.Features.Contracts;

/// <summary>
/// The M0 contract surface: every route is reachable, every unbuilt one says so in the same way.
/// </summary>
/// <remarks>
/// <para>
/// These endpoints exist so the frontend lane can generate types and mocks before the behaviour
/// is written. That only works if two things are true, and both are asserted here: the routes are
/// actually registered, and an unbuilt one answers 501 with a code a client can branch on rather
/// than 404, which is indistinguishable from a typo in the path.
/// </para>
/// <para>
/// As each endpoint gains behaviour its row leaves this theory. When the theory is empty, the
/// contract surface has been fully implemented - which makes this file a to-do list that cannot
/// go stale.
/// </para>
/// <para>
/// The whole items feature has already left it: list, create, get, rename, move, delete and
/// restore are implemented and covered by the integration suite instead, because they need a
/// database and a tenant-scoped unit of work to say anything true. This host is deliberately built
/// without persistence, so asserting anything about them here would be asserting the behaviour of
/// a misconfiguration. What remains is workspaces, permissions and roles.
/// </para>
/// </remarks>
public sealed class ContractStubTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private const string ItemId = "8f7c3a10-0000-4000-8000-000000000001";
    private const string WorkspaceId = "8f7c3a10-0000-4000-8000-000000000002";
    private const string AclEntryId = "8f7c3a10-0000-4000-8000-000000000003";

    /// <summary>Every published-but-unbuilt operation, with a body where one is required.</summary>
    public static TheoryData<string, string, string?> UnimplementedOperations => new()
    {
        { "GET", "/api/v1/workspaces", null },
        { "GET", $"/api/v1/workspaces/{WorkspaceId}", null },
        { "GET", $"/api/v1/workspaces/{WorkspaceId}/members", null },
        { "GET", $"/api/v1/items/{ItemId}/permissions", null },
        {
            "PUT",
            $"/api/v1/items/{ItemId}/permissions/entries",
            """{"subjectType":"principal","subjectId":"8f7c3a10-0000-4000-8000-000000000004","role":"editor","effect":"allow","breaksInheritance":false}"""
        },
        { "DELETE", $"/api/v1/items/{ItemId}/permissions/entries/{AclEntryId}", null },
        { "GET", "/api/v1/tenant/roles", null },
    };

    [Theory]
    [MemberData(nameof(UnimplementedOperations))]
    public async Task Every_published_contract_route_is_registered_and_answers_not_implemented(
        string method,
        string path,
        string? body)
    {
        using var client = factory.CreateClient();

        using var response = await SendAsync(client, method, path, body);

        // 404 here would mean the route does not exist - which a client cannot tell apart from
        // having got the path wrong, and which would make the published contract a fiction.
        Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
    }

    [Theory]
    [MemberData(nameof(UnimplementedOperations))]
    public async Task Every_unimplemented_route_carries_the_stable_not_implemented_code(
        string method,
        string path,
        string? body)
    {
        using var client = factory.CreateClient();

        using var response = await SendAsync(client, method, path, body);
        var problem = await response.Content.ReadFromJsonAsync<JsonObject>(
            TestContext.Current.CancellationToken);

        Assert.NotNull(problem);

        // The client switches on this literal and never on the message text.
        Assert.Equal("api.not_implemented", (string?)problem["code"]);

        // Present on every problem response, so a user-visible failure joins to a trace.
        Assert.False(string.IsNullOrWhiteSpace((string?)problem["traceId"]));

        Assert.Equal(501, (int?)problem["status"]);
    }

    [Fact]
    public async Task An_unknown_route_is_still_a_not_found_rather_than_a_stub()
    {
        // The stub response must not be so broad that it swallows genuine routing mistakes.
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            new Uri("/api/v1/items/not-a-guid/nonsense", UriKind.Relative),
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task A_malformed_identifier_does_not_reach_the_stub()
    {
        // The route constraint rejects it first, so a client gets "that is not an item id" rather
        // than "this feature is not built", which are different problems with different fixes.
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            new Uri("/api/v1/items/not-a-guid", UriKind.Relative),
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        string method,
        string path,
        string? body)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(path, UriKind.Relative));

        if (body is not null)
        {
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }

        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }
}
