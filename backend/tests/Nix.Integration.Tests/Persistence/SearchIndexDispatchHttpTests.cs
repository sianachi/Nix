using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Proves the authenticated HTTP contract consumed by the Go indexer.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SearchIndexDispatchHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string InternalSecret = "search-index-dispatch-http-secret";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsMigratorAsync(
            """
            UPDATE item_search
               SET body_text = @body,
                   body_vector = to_tsvector('english', @body),
                   updated_at = clock_timestamp()
             WHERE tenant_id = @tenant_id
               AND item_id = @item_id
            """,
            new NpgsqlParameter("body", "search worker body"),
            new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("item_id", M0SchemaSeed.Alpha.ItemId));

        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Metadata_and_body_require_the_internal_secret_and_exact_tenant_item_pair()
    {
        using var publicRequest = new HttpRequestMessage(
            HttpMethod.Get,
            MetadataPath(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.ItemId));
        using var refused = await _client.SendAsync(publicRequest, Cancellation);
        Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);

        using var metadata = await SendInternalAsync(
            HttpMethod.Get,
            MetadataPath(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.ItemId));
        metadata.EnsureSuccessStatusCode();
        using (var document = JsonDocument.Parse(await metadata.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, document.RootElement.GetProperty("tenant_id").GetGuid());
            Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, document.RootElement.GetProperty("workspace_id").GetGuid());
            Assert.Equal(M0SchemaSeed.Alpha.ItemId, document.RootElement.GetProperty("item_id").GetGuid());
            Assert.True(document.RootElement.GetProperty("indexable").GetBoolean());
        }

        using var crossTenant = await SendInternalAsync(
            HttpMethod.Get,
            MetadataPath(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Beta.ItemId));
        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);

        using var body = await SendInternalAsync(
            HttpMethod.Get,
            $"{MetadataPath(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.ItemId)}/body");
        body.EnsureSuccessStatusCode();
        Assert.Equal("text/plain; charset=utf-8", body.Content.Headers.ContentType?.ToString());
        Assert.Equal("nosniff", Assert.Single(body.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("search worker body", await body.Content.ReadAsStringAsync(Cancellation));
    }

    [Fact]
    public async Task Rebuild_and_status_form_a_restartable_bounded_internal_contract()
    {
        using var rebuild = await SendInternalAsync(
            HttpMethod.Post,
            "/internal/worker-dispatch/index/rebuild",
            JsonContent.Create(new { limit = 1 }));
        rebuild.EnsureSuccessStatusCode();
        using (var page = JsonDocument.Parse(await rebuild.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal(1, page.RootElement.GetProperty("enqueued").GetInt32());
            Assert.True(page.RootElement.GetProperty("hasMore").GetBoolean());
            Assert.NotEqual(Guid.Empty, page.RootElement.GetProperty("nextTenantId").GetGuid());
            Assert.NotEqual(Guid.Empty, page.RootElement.GetProperty("nextItemId").GetGuid());
        }

        using var status = await SendInternalAsync(
            HttpMethod.Get,
            "/internal/worker-dispatch/index/status");
        status.EnsureSuccessStatusCode();
        using var report = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.True(report.RootElement.GetProperty("pending").GetInt64() >= 1);
        Assert.Equal(0, report.RootElement.GetProperty("pendingFailures").GetInt64());
    }

    [Fact]
    public async Task Rebuild_refuses_partial_empty_and_unbounded_cursors()
    {
        foreach (var payload in new object[]
        {
            new { afterTenantId = M0SchemaSeed.Alpha.TenantId, limit = 10 },
            new { afterTenantId = Guid.Empty, afterItemId = Guid.Empty, limit = 10 },
            new { limit = 1001 },
        })
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                "/internal/worker-dispatch/index/rebuild");
            request.Headers.TryAddWithoutValidation(
                InternalBoundaryMiddleware.SecretHeaderName,
                InternalSecret);
            request.Content = JsonContent.Create(payload);
            using var response = await _client.SendAsync(request, Cancellation);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
    }

    private async Task<HttpResponseMessage> SendInternalAsync(
        HttpMethod method,
        string path,
        HttpContent? content = null)
    {
        using var request = new HttpRequestMessage(method, path) { Content = content };
        request.Headers.TryAddWithoutValidation(
            InternalBoundaryMiddleware.SecretHeaderName,
            InternalSecret);
        return await _client.SendAsync(request, Cancellation);
    }

    private static string MetadataPath(Guid tenantId, Guid itemId) =>
        $"/internal/worker-dispatch/index/items/{tenantId:D}/{itemId:D}";

    private async Task ExecuteAsMigratorAsync(string sql, params NpgsqlParameter[] parameters)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Justification: every statement passed here is static test SQL; values remain bound parameters.
            var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);
                await command.ExecuteNonQueryAsync(Cancellation).ConfigureAwait(false);
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
