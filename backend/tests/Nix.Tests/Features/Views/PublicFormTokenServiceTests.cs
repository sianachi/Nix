using Microsoft.Extensions.Configuration;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Views;

namespace Nix.Tests.Features.Views;

public sealed class PublicFormTokenServiceTests
{
    private const string SigningKey = "a-test-signing-key-that-is-at-least-thirty-two-bytes";

    [Fact]
    public void A_signed_token_round_trips_its_capability_identity()
    {
        var service = CreateService(SigningKey);
        var tenantId = TenantId.Create();
        var linkId = Guid.CreateVersion7();
        var principalId = PrincipalId.Create();

        var token = service.Create(tenantId, linkId, principalId, "nonce");

        Assert.True(service.TryRead(token, out var payload));
        Assert.Equal(tenantId.Value, payload.TenantId);
        Assert.Equal(linkId, payload.LinkId);
        Assert.Equal(principalId.Value, payload.SubmissionPrincipalId);
        Assert.Equal("nonce", payload.Nonce);
    }

    [Fact]
    public void A_tampered_or_differently_signed_token_is_rejected()
    {
        var service = CreateService(SigningKey);
        var token = service.Create(TenantId.Create(), Guid.CreateVersion7(), PrincipalId.Create(), "nonce");
        var tampered = $"{token[..^1]}{(token[^1] == 'a' ? 'b' : 'a')}";

        Assert.False(service.TryRead(tampered, out _));
        Assert.False(CreateService($"{SigningKey}-different").TryRead(token, out _));
    }

    private static PublicFormTokenService CreateService(string signingKey) =>
        new(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                [PublicFormTokenService.SigningKeyConfiguration] = signingKey,
            }).Build());
}
