using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Persists the durable identity and personal workspace for a validated external subject.</summary>
public interface IPersonalWorkspaceProvisioner
{
    /// <summary>Creates or observes the single winning personal-workspace foundation.</summary>
    public ValueTask<AuthenticatedPrincipal> ProvisionAsync(
        TenantId tenantId,
        string issuer,
        string subject,
        UserInfoProfile profile,
        CancellationToken cancellationToken);
}

/// <summary>Signals a failure of the durable personal-workspace invariant.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Design",
    "CA1032:Implement standard exception constructors",
    Justification = "This internal invariant carries no caller-provided data.")]
public sealed class PersonalWorkspaceProvisioningInvariantException : Exception
{
    /// <summary>Initializes a safe invariant failure without retaining provider data.</summary>
    public PersonalWorkspaceProvisioningInvariantException()
        : base("First-login provisioning did not satisfy its durable identity invariant.")
    {
    }
}
