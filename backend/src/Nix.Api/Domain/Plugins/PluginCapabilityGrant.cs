using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

/// <summary>One explicit host capability granted to one workspace installation.</summary>
public sealed class PluginCapabilityGrant
{
    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the installation receiving the grant.</summary>
    public required PluginInstallationId InstallationId { get; init; }

    /// <summary>Gets the closed capability identifier.</summary>
    public required string Capability { get; init; }

    /// <summary>Gets who granted the capability.</summary>
    public required PrincipalId GrantedBy { get; init; }

    /// <summary>Gets when the capability was granted.</summary>
    public required DateTimeOffset GrantedAt { get; init; }
}
