using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Nix.Tests.Harness;
using Nix.Tests.Support;

namespace Nix.Tests.Features.Health;

/// <summary>
/// Contract tests for the health feature, exercised through the real host so that
/// routing, the source-generated serializer, and the wire format are all under test
/// rather than the delegates in isolation.
/// </summary>
public sealed class HealthEndpointsTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Fact]
    public async Task Liveness_probe_answers_200_with_a_healthy_status()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(new Uri("/healthz", UriKind.Relative), cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"status":"healthy"}""", body);
    }

    [Fact]
    public async Task Liveness_probe_body_carries_nothing_beyond_the_status_field()
    {
        using var client = factory.CreateClient();

        var body = await ReadJsonObjectAsync(client, "/healthz");

        Assert.Equal(["status"], body.Select(property => property.Key));
    }

    [Fact]
    public async Task Status_endpoint_reports_the_service_name_version_and_utc_clock()
    {
        using var client = factory.CreateClient();

        var body = await ReadJsonObjectAsync(client, "/api/v1/health/status");

        Assert.Equal(["service", "version", "utcNow"], body.Select(property => property.Key));
        Assert.Equal("nix-api", (string?)body["service"]);
        Assert.False(string.IsNullOrWhiteSpace((string?)body["version"]));
    }

    [Fact]
    public async Task Status_endpoint_reads_the_clock_from_the_injected_time_provider()
    {
        var instant = new DateTimeOffset(2026, 3, 14, 15, 9, 26, TimeSpan.Zero);
        using var isolated = factory.WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services =>
                services.AddSingleton<TimeProvider>(new FixedTimeProvider(instant))));
        using var client = isolated.CreateClient();

        var body = await ReadJsonObjectAsync(client, "/api/v1/health/status");

        Assert.Equal(
            instant,
            DateTimeOffset.Parse((string?)body["utcNow"] ?? string.Empty, CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Named_health_check_that_exists_answers_200_with_its_result()
    {
        using var client = factory.CreateClient();

        var body = await ReadJsonObjectAsync(client, "/api/v1/health/checks/self");

        Assert.Equal("self", (string?)body["name"]);
        Assert.Equal("healthy", (string?)body["status"]);
    }

    private static async Task<JsonObject> ReadJsonObjectAsync(HttpClient client, string path)
    {
        var cancellationToken = TestContext.Current.CancellationToken;

        using var response = await client.GetAsync(new Uri(path, UriKind.Relative), cancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return Assert.IsType<JsonObject>(
            await JsonNode.ParseAsync(stream, cancellationToken: cancellationToken));
    }
}
