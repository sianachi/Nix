using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Identity;

/// <summary>Creates the personal foundation for one validated external human identity.</summary>
public sealed record ProvisionPersonalWorkspace(
    TenantId TenantId,
    string Issuer,
    string Subject,
    UserInfoProfile Profile) : ICommand<AuthenticatedPrincipal>;

/// <summary>Runs first-login provisioning through the application's command seam.</summary>
public sealed class ProvisionPersonalWorkspaceHandler(IPersonalWorkspaceProvisioner provisioner)
    : ICommandHandler<ProvisionPersonalWorkspace, AuthenticatedPrincipal>
{
    /// <inheritdoc />
    public async ValueTask<Result<AuthenticatedPrincipal>> HandleAsync(
        ProvisionPersonalWorkspace command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var principal = await provisioner.ProvisionAsync(
            command.TenantId,
            command.Issuer,
            command.Subject,
            command.Profile,
            cancellationToken).ConfigureAwait(false);
        return Result.Success(principal);
    }
}
