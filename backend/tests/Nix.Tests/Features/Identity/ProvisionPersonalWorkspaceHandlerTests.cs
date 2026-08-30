using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Identity;

namespace Nix.Tests.Features.Identity;

public sealed class ProvisionPersonalWorkspaceHandlerTests
{
    [Fact]
    public async Task Handler_forwards_the_validated_identity_and_cancellation_to_the_provisioning_port()
    {
        var expected = new AuthenticatedPrincipal(
            PrincipalId.Create(), TenantId.From(Guid.NewGuid()), PrincipalStatus.Active, "Nix user");
        var fake = new FakeProvisioner(expected);
        var handler = new ProvisionPersonalWorkspaceHandler(fake);
        using var cancellation = new CancellationTokenSource();
        var command = new ProvisionPersonalWorkspace(
            expected.TenantId,
            "https://issuer.example.test",
            "external-subject",
            new UserInfoProfile(null, "person@example.test", EmailVerified: true));

        var result = await handler.HandleAsync(command, cancellation.Token);

        Assert.True(result.IsSuccess);
        Assert.Equal(expected, result.Value);
        Assert.Equal(command, fake.Command);
        Assert.Equal(cancellation.Token, fake.CancellationToken);
    }

    private sealed class FakeProvisioner(AuthenticatedPrincipal result) : IPersonalWorkspaceProvisioner
    {
        public ProvisionPersonalWorkspace? Command { get; private set; }

        public CancellationToken CancellationToken { get; private set; }

        public ValueTask<AuthenticatedPrincipal> ProvisionAsync(
            TenantId tenantId,
            string issuer,
            string subject,
            UserInfoProfile profile,
            CancellationToken cancellationToken)
        {
            Command = new ProvisionPersonalWorkspace(tenantId, issuer, subject, profile);
            CancellationToken = cancellationToken;
            return ValueTask.FromResult(result);
        }
    }
}
