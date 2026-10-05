using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>
/// A named set of principals, mirrored from the tenant's identity provider.
/// </summary>
/// <remarks>
/// Groups are a provisioning concept, not an authorization one: they exist so an access control
/// entry can name "engineering" instead of forty people, and membership arrives from the provider
/// rather than being edited here.
/// </remarks>
public sealed class PrincipalGroup
{
    /// <summary>Gets the group's identifier.</summary>
    public required PrincipalGroupId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the group's display name.</summary>
    public required string Name { get; init; }

    /// <summary>
    /// Gets the provider's own identifier for this group, or <see langword="null"/> for a group
    /// created in Nix rather than mirrored. Reconciliation matches on this, not on the name,
    /// because names are renamed.
    /// </summary>
    public string? ExternalId { get; init; }
}
