using System.Text.Json;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Features.Plugins;
using Nix.Persistence.ObjectStorage;

namespace Nix.Tests.Features.Plugins;

public sealed class PluginContractValidatorTests
{
    private static readonly TenantId Tenant = TenantId.From(
        Guid.Parse("10000000-0000-4000-8000-000000000001"));

    [Fact]
    public void A_publisher_qualified_signed_component_is_normalized_without_changing_its_identity()
    {
        var digest = new string('a', 64);
        var request = new PluginComponentRegistrationRequest(
            "example.plugins",
            "example.plugins/planner",
            "1.2.3-alpha-beta.1+mac-arm64",
            ObjectStorageKeys.PluginComponent(
                Tenant,
                "example.plugins/planner",
                "1.2.3-alpha-beta.1+mac-arm64",
                digest),
            digest,
            4096,
            Convert.ToBase64String(new byte[32]),
            Convert.ToBase64String(new byte[64]));

        Assert.True(PluginContractValidator.TryComponent(Tenant, request, out var component));
        Assert.Equal(new string('A', 64), component.Sha256);
        Assert.Equal(request.Version, component.Version);
        Assert.Equal(32, component.PublicKey.Length);
        Assert.Equal(64, component.Signature.Length);
    }

    [Theory]
    [InlineData("Example.plugins", "Example.plugins/planner", "1.0.0")]
    [InlineData("example.plugins", "other.plugins/planner", "1.0.0")]
    [InlineData("example.plugins", "example.plugins/-planner", "1.0.0")]
    [InlineData("example.plugins", "example.plugins/planner", "01.0.0")]
    [InlineData("example.plugins", "example.plugins/planner", "1.0.0-alpha.01")]
    [InlineData("example.plugins", "example.plugins/planner", "1.0")]
    public void Invalid_component_identity_or_version_is_refused(
        string publisherId,
        string componentId,
        string version)
    {
        var digest = new string('A', 64);
        var request = new PluginComponentRegistrationRequest(
            publisherId,
            componentId,
            version,
            "plugins/components/invalid/component.wasm",
            digest,
            1,
            Convert.ToBase64String(new byte[32]),
            Convert.ToBase64String(new byte[64]));

        Assert.False(PluginContractValidator.TryComponent(Tenant, request, out _));
    }

    [Fact]
    public void A_component_object_key_is_bound_to_tenant_identity_version_and_digest()
    {
        var digest = new string('A', 64);
        var request = new PluginComponentRegistrationRequest(
            "example.plugins",
            "example.plugins/planner",
            "1.0.0",
            ObjectStorageKeys.PluginComponent(
                TenantId.From(Guid.Parse("20000000-0000-4000-8000-000000000002")),
                "example.plugins/planner",
                "1.0.0",
                digest),
            digest,
            1,
            Convert.ToBase64String(new byte[32]),
            Convert.ToBase64String(new byte[64]));

        Assert.False(PluginContractValidator.TryComponent(Tenant, request, out _));
    }

    [Fact]
    public void Workspace_events_require_an_exact_root_causation_and_bounded_lease()
    {
        var eventId = Guid.NewGuid();
        var tenantId = Guid.NewGuid();
        var workspaceId = Guid.NewGuid();
        var itemId = Guid.NewGuid();

        Assert.True(PluginContractValidator.ValidEvent(
            eventId, tenantId, workspaceId, itemId, "item.changed", 1, eventId, 0, 60));
        Assert.False(PluginContractValidator.ValidEvent(
            eventId, tenantId, workspaceId, itemId, "item.changed", 1, Guid.NewGuid(), 0, 60));
        Assert.False(PluginContractValidator.ValidEvent(
            eventId, tenantId, workspaceId, itemId, "item.changed", 0, eventId, 0, 60));
        Assert.False(PluginContractValidator.ValidEvent(
            eventId, tenantId, workspaceId, itemId, "item.changed", 1, eventId, 1, 60));
        Assert.False(PluginContractValidator.ValidEvent(
            eventId, tenantId, workspaceId, itemId, "item.changed", 1, eventId, 0, 301));
    }

    [Fact]
    public void Host_calls_accept_only_the_closed_capability_and_exact_payload()
    {
        var itemId = Guid.NewGuid();
        using var exact = JsonDocument.Parse($$"""{"itemId":"{{itemId:D}}"}""");
        using var extra = JsonDocument.Parse($$"""{"itemId":"{{itemId:D}}","extra":true}""");

        Assert.True(PluginContractValidator.TryReadItemMetadata(
            PluginRuntimePolicy.ReadItemMetadataCapability,
            exact.RootElement,
            out var parsed));
        Assert.Equal(itemId, parsed);
        Assert.False(PluginContractValidator.TryReadItemMetadata(
            "items.write",
            exact.RootElement,
            out _));
        Assert.False(PluginContractValidator.TryReadItemMetadata(
            PluginRuntimePolicy.ReadItemMetadataCapability,
            extra.RootElement,
            out _));
    }

    [Theory]
    [InlineData(true, false, null, null, true)]
    [InlineData(true, true, null, null, false)]
    [InlineData(false, true, "plugin.transient", "Try again.", true)]
    [InlineData(false, false, "bad code", "Refused.", false)]
    [InlineData(false, false, "plugin.failed", "line\nbreak", false)]
    public void Completion_reports_are_bounded_and_self_consistent(
        bool succeeded,
        bool retryable,
        string? errorCode,
        string? errorDetail,
        bool expected)
    {
        Assert.Equal(
            expected,
            PluginContractValidator.ValidCompletion(
                succeeded,
                retryable,
                errorCode,
                errorDetail));
    }
}
