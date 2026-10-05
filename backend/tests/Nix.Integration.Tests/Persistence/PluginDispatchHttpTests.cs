using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Domain.Plugins;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Proves the authenticated, capability-only HTTP contract consumed by the Go plugin role.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PluginDispatchHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string InternalSecret = "plugin-dispatch-http-secret";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            ["Nix:ObjectStorage:Endpoint"] = "https://objects.example.test/api",
            ["Nix:ObjectStorage:Region"] = "eu-west-2",
            ["Nix:ObjectStorage:Bucket"] = "nix-test-objects",
            ["Nix:ObjectStorage:AccessKey"] = "test-access",
            ["Nix:ObjectStorage:SecretKey"] = "test-secret",
            ["Nix:ObjectStorage:CapabilitySeconds"] = "300",
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Prepare_host_call_and_completion_require_the_internal_boundary()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, aggregateVersion: 17);
        var path = $"/internal/worker-dispatch/plugins/events/{eventId:D}/prepare";
        var payload = new
        {
            tenantId = M0SchemaSeed.Alpha.TenantId,
            workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
            itemId = M0SchemaSeed.Alpha.ItemId,
            kind = "item.changed",
            aggregateVersion = 17,
            causationId = eventId,
            causationDepth = 0,
            leaseSeconds = 60,
        };

        using (var publicRequest = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(payload),
        })
        using (var refused = await _client.SendAsync(publicRequest, Cancellation))
        {
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
        }

        using var prepared = await SendInternalAsync(
            HttpMethod.Post,
            path,
            JsonContent.Create(payload));
        prepared.EnsureSuccessStatusCode();
        using var response = JsonDocument.Parse(await prepared.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("prepared", response.RootElement.GetProperty("outcome").GetString());
        var plan = Assert.Single(response.RootElement.GetProperty("plans").EnumerateArray());
        var invocationId = plan.GetProperty("invocationId").GetGuid();
        var component = plan.GetProperty("component");
        Assert.Equal("nix.seed/alpha", component.GetProperty("id").GetString());
        Assert.Equal(32, Convert.FromBase64String(component.GetProperty("publicKey").GetString()!).Length);
        Assert.Equal(64, Convert.FromBase64String(component.GetProperty("signature").GetString()!).Length);
        var download = new Uri(
            component.GetProperty("downloadUrl").GetString()!,
            UriKind.Absolute);
        Assert.Equal("objects.example.test", download.Host);
        Assert.Contains("/nix-test-objects/plugins/components/", download.AbsolutePath, StringComparison.Ordinal);
        Assert.Contains("X-Amz-Signature=", download.Query, StringComparison.Ordinal);

        using var hostCall = await SendInternalAsync(
            HttpMethod.Post,
            $"/internal/worker-dispatch/plugins/invocations/{invocationId:D}/host-calls",
            JsonContent.Create(new
            {
                capability = PluginRuntimePolicy.ReadItemMetadataCapability,
                request = new { itemId = M0SchemaSeed.Alpha.ItemId },
            }));
        hostCall.EnsureSuccessStatusCode();
        using (var hostResult = JsonDocument.Parse(await hostCall.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal(
                M0SchemaSeed.Alpha.ItemId,
                hostResult.RootElement.GetProperty("result").GetProperty("itemId").GetGuid());
            Assert.Equal(
                eventId,
                hostResult.RootElement.GetProperty("result").GetProperty("causationId").GetGuid());
        }

        using var completed = await SendInternalAsync(
            HttpMethod.Post,
            $"/internal/worker-dispatch/plugins/invocations/{invocationId:D}/complete",
            JsonContent.Create(new { succeeded = true, retryable = false }));
        completed.EnsureSuccessStatusCode();
        using var completion = JsonDocument.Parse(await completed.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("applied", completion.RootElement.GetProperty("outcome").GetString());
        Assert.False(completion.RootElement.GetProperty("shouldRequeue").GetBoolean());
    }

    [Fact]
    public async Task Prepare_distinguishes_invalid_fabricated_and_scope_modified_events()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, aggregateVersion: 19);

        using var invalid = await SendInternalAsync(
            HttpMethod.Post,
            $"/internal/worker-dispatch/plugins/events/{eventId:D}/prepare",
            JsonContent.Create(new
            {
                tenantId = M0SchemaSeed.Alpha.TenantId,
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
                itemId = M0SchemaSeed.Alpha.ItemId,
                kind = "item.changed",
                aggregateVersion = 0,
                causationId = eventId,
                causationDepth = 0,
                leaseSeconds = 60,
            }));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        var fabricatedId = Guid.NewGuid();
        using var fabricated = await SendInternalAsync(
            HttpMethod.Post,
            $"/internal/worker-dispatch/plugins/events/{fabricatedId:D}/prepare",
            JsonContent.Create(new
            {
                tenantId = M0SchemaSeed.Alpha.TenantId,
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
                itemId = M0SchemaSeed.Alpha.ItemId,
                kind = "item.changed",
                aggregateVersion = 19,
                causationId = fabricatedId,
                causationDepth = 0,
                leaseSeconds = 60,
            }));
        Assert.Equal(HttpStatusCode.NotFound, fabricated.StatusCode);

        using var modified = await SendInternalAsync(
            HttpMethod.Post,
            $"/internal/worker-dispatch/plugins/events/{eventId:D}/prepare",
            JsonContent.Create(new
            {
                tenantId = M0SchemaSeed.Alpha.TenantId,
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
                itemId = M0SchemaSeed.Alpha.ItemId,
                kind = "item.changed",
                aggregateVersion = 20,
                causationId = eventId,
                causationDepth = 0,
                leaseSeconds = 60,
            }));
        Assert.Equal(HttpStatusCode.Conflict, modified.StatusCode);
    }

    private async Task<HttpResponseMessage> SendInternalAsync(
        HttpMethod method,
        string path,
        HttpContent content)
    {
        using var request = new HttpRequestMessage(method, path) { Content = content };
        request.Headers.TryAddWithoutValidation(
            InternalBoundaryMiddleware.SecretHeaderName,
            InternalSecret);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task InsertOutboxEventAsync(Guid eventId, long aggregateVersion)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: static test SQL with bound values.
            var command = new NpgsqlCommand(
                """
                INSERT INTO worker_outbox_event
                    (event_id, tenant_id, workspace_id, item_id, kind, aggregate_version,
                     payload, available_at, attempts)
                VALUES (@event_id, @tenant_id, @workspace_id, @item_id, 'item.changed',
                        @aggregate_version, '{}'::jsonb, now(), 0)
                """,
                connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("event_id", eventId);
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("workspace_id", M0SchemaSeed.Alpha.WorkspaceId);
                command.Parameters.AddWithValue("item_id", M0SchemaSeed.Alpha.ItemId);
                command.Parameters.AddWithValue("aggregate_version", aggregateVersion);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }
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
