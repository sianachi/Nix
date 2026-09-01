using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Proves the owner/admin-only public plugin catalog and immutable upload contract.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PluginCatalogHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Editor = new("91919191-1111-4111-8111-919191919191");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await SeedEditorAsync();
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.plugin-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "plugin-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
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
    public async Task Administrator_can_upload_register_grant_enable_and_list_a_component()
    {
        var jwt = await JwtAsync(M0SchemaSeed.Alpha.PrincipalId);
        var digest = new string('C', 64);
        var component = new
        {
            publisherId = "example.plugins",
            id = "example.plugins/planner",
            version = "1.2.3-alpha-beta.1+arm64",
            sha256 = digest,
            byteLength = 8,
            publicKey = Convert.ToBase64String(Enumerable.Repeat((byte)0x41, 32).ToArray()),
            signature = Convert.ToBase64String(Enumerable.Repeat((byte)0x51, 64).ToArray()),
        };
        var root = $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/plugins";

        using var upload = await SendAsync(
            HttpMethod.Post,
            root + "/components/upload",
            jwt,
            component);
        upload.EnsureSuccessStatusCode();
        using var capability = JsonDocument.Parse(await upload.Content.ReadAsStringAsync(Cancellation));
        var objectKey = capability.RootElement.GetProperty("objectKey").GetString()!;
        Assert.StartsWith(
            $"plugins/components/{M0SchemaSeed.Alpha.TenantId:D}/example.plugins/planner/",
            objectKey,
            StringComparison.Ordinal);
        Assert.Equal("*", capability.RootElement.GetProperty("ifNoneMatch").GetString());
        Assert.Equal(
            32,
            Convert.FromBase64String(
                capability.RootElement.GetProperty("xAmzChecksumSha256").GetString()!).Length);
        var uploadUrl = new Uri(
            capability.RootElement.GetProperty("uploadUrl").GetString()!,
            UriKind.Absolute);
        Assert.Contains("if-none-match", uploadUrl.Query, StringComparison.Ordinal);
        Assert.Contains("x-amz-checksum-sha256", uploadUrl.Query, StringComparison.Ordinal);

        using var registered = await SendAsync(
            HttpMethod.Post,
            root,
            jwt,
            new
            {
                component.publisherId,
                component.id,
                component.version,
                objectKey,
                component.sha256,
                component.byteLength,
                component.publicKey,
                component.signature,
            });
        Assert.Equal(HttpStatusCode.Created, registered.StatusCode);
        using var installation = JsonDocument.Parse(await registered.Content.ReadAsStringAsync(Cancellation));
        var installationId = installation.RootElement.GetProperty("id").GetGuid();
        Assert.False(installation.RootElement.GetProperty("enabled").GetBoolean());

        using var granted = await SendAsync(
            HttpMethod.Put,
            $"{root}/{installationId:D}/capabilities",
            jwt,
            new { capabilities = new[] { PluginRuntimePolicy.ReadItemMetadataCapability } });
        granted.EnsureSuccessStatusCode();
        using var enabled = await SendAsync(
            HttpMethod.Put,
            $"{root}/{installationId:D}/enabled",
            jwt,
            new { enabled = true });
        enabled.EnsureSuccessStatusCode();

        using var replay = await SendAsync(
            HttpMethod.Post,
            root,
            jwt,
            new
            {
                component.publisherId,
                component.id,
                component.version,
                objectKey,
                component.sha256,
                component.byteLength,
                component.publicKey,
                component.signature,
            });
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);

        using var listed = await SendAsync(HttpMethod.Get, root, jwt);
        listed.EnsureSuccessStatusCode();
        using var catalog = JsonDocument.Parse(await listed.Content.ReadAsStringAsync(Cancellation));
        var row = catalog.RootElement.EnumerateArray().Single(value =>
            value.GetProperty("id").GetGuid() == installationId);
        Assert.True(row.GetProperty("enabled").GetBoolean());
        Assert.Equal(
            PluginRuntimePolicy.ReadItemMetadataCapability,
            Assert.Single(row.GetProperty("capabilities").EnumerateArray()).GetString());
        Assert.False(row.TryGetProperty("objectKey", out _));
        Assert.False(row.TryGetProperty("publicKey", out _));
        Assert.False(row.TryGetProperty("signature", out _));
    }

    [Fact]
    public async Task An_editor_can_read_but_cannot_pin_or_change_plugin_trust()
    {
        var jwt = await JwtAsync(Editor);
        var root = $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/plugins";

        using var listed = await SendAsync(HttpMethod.Get, root, jwt);
        listed.EnsureSuccessStatusCode();

        using var refused = await SendAsync(
            HttpMethod.Post,
            root + "/components/upload",
            jwt,
            new
            {
                publisherId = "example.plugins",
                id = "example.plugins/planner",
                version = "1.0.0",
                sha256 = new string('A', 64),
                byteLength = 8,
                publicKey = Convert.ToBase64String(new byte[32]),
                signature = Convert.ToBase64String(new byte[64]),
            });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("plugins.management_forbidden", await ProblemCodeAsync(refused));
    }

    [Fact]
    public async Task Cross_tenant_workspace_and_spoofed_component_metadata_are_refused()
    {
        var jwt = await JwtAsync(M0SchemaSeed.Alpha.PrincipalId);
        using var hidden = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/workspaces/{M0SchemaSeed.Beta.WorkspaceId:D}/plugins",
            jwt);
        Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);

        using var invalid = await SendAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/plugins/components/upload",
            jwt,
            new
            {
                publisherId = "example.plugins",
                id = "other.plugins/planner",
                version = "1.0.0",
                sha256 = new string('A', 64),
                byteLength = 8,
                publicKey = Convert.ToBase64String(new byte[32]),
                signature = Convert.ToBase64String(new byte[64]),
            });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal("plugins.component_invalid", await ProblemCodeAsync(invalid));
    }

    private async Task<string> JwtAsync(Guid principalId)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            NixSessionContext.ForTenant(
                TenantId.From(M0SchemaSeed.Alpha.TenantId),
                PrincipalId.From(principalId)),
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                "plugin-http",
                [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin],
                1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);

        using var exchange = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string path,
        string jwt,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }

    private async Task SeedEditorAsync()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES ('{Editor:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        'https://plugin-http.test', 'editor', 'user', 'Plugin editor',
                        'plugin-editor@example.test', 'plugin-editor@example.test', true, 'active');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{M0SchemaSeed.Alpha.WorkspaceId:D}', 'principal', '{Editor:D}',
                        '{M0SchemaSeed.Alpha.TenantId:D}', 'editor',
                        '{M0SchemaSeed.Alpha.PrincipalId:D}', now());
                """);
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
