using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Nix.Tests.Errors;

/// <summary>
/// The error contract, pinned. The frontend switches on <c>code</c>, so a change to
/// any assertion here is a breaking API change, not a test that needs updating.
/// </summary>
public sealed class ProblemDetailsContractTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Endpoint_failure_answers_RFC_9457_problem_details_with_a_stable_code()
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            new Uri("/api/v1/health/checks/nope", UriKind.Relative),
            TestContext.Current.CancellationToken);
        var problem = await ReadProblemAsync(response);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("health.check_not_found", (string?)problem["code"]);
        Assert.Equal(404, (int?)problem["status"]);
        Assert.Equal("Health check not found", (string?)problem["title"]);
        Assert.Equal("/api/v1/health/checks/nope", (string?)problem["instance"]);
        Assert.False(string.IsNullOrWhiteSpace((string?)problem["type"]));
        Assert.False(string.IsNullOrWhiteSpace((string?)problem["detail"]));
        Assert.False(string.IsNullOrWhiteSpace((string?)problem["traceId"]));
    }

    [Fact]
    public async Task Framework_produced_failure_answers_the_same_shape_with_the_fallback_code()
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            new Uri("/no/such/route", UriKind.Relative),
            TestContext.Current.CancellationToken);
        var problem = await ReadProblemAsync(response);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("api.unexpected_error", (string?)problem["code"]);
        Assert.Equal("/no/such/route", (string?)problem["instance"]);
        Assert.False(string.IsNullOrWhiteSpace((string?)problem["traceId"]));
    }

    private static async Task<JsonObject> ReadProblemAsync(HttpResponseMessage response)
    {
        var cancellationToken = TestContext.Current.CancellationToken;

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return Assert.IsType<JsonObject>(
            await JsonNode.ParseAsync(stream, cancellationToken: cancellationToken));
    }
}
