using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

/// <summary>A workspace-scoped installation of one exact immutable component version.</summary>
public sealed class PluginInstallation
{
    /// <summary>Gets the installation identity.</summary>
    public required PluginInstallationId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace receiving events.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the installed publisher-qualified component identity.</summary>
    public required string ComponentId { get; init; }

    /// <summary>Gets the installed immutable semantic version.</summary>
    public required string ComponentVersion { get; init; }

    /// <summary>Gets whether new workspace events may invoke this installation.</summary>
    public required bool Enabled { get; set; }

    /// <summary>Gets who installed the component.</summary>
    public required PrincipalId InstalledBy { get; init; }

    /// <summary>Gets when the installation was created.</summary>
    public required DateTimeOffset InstalledAt { get; init; }

    /// <summary>Gets when mutable installation state last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; set; }
}
