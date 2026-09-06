using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Content;

/// <summary>Personal companion settings, never shared workspace content.</summary>
public sealed class PetPreferences
{
    /// <summary>Gets the tenant whose principal owns these preferences.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the owner.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the validated, bounded configuration document.</summary>
    public required string SettingsJson { get; init; }

    /// <summary>Gets the version used to refuse stale edits from other devices.</summary>
    public required long Revision { get; init; }
}
