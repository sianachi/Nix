using Nix.Domain.Authorization;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>
/// A workspace-level role held by a principal or a group: the middle authorization layer, and the
/// chain-root allow that item resolution falls back to when no access control entry matches.
/// </summary>
/// <remarks>
/// <see cref="Role"/> is text for the same reason as on <see cref="TenantRoleGrant"/> - the
/// vocabulary belongs to the authorization goal, not to the schema that stores it.
/// </remarks>
public sealed class WorkspaceMember
{
    /// <summary>Gets the workspace the role is held in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets whether the role is held by a principal or a group.</summary>
    public required SubjectType SubjectType { get; init; }

    /// <summary>Gets the holder's identifier, interpreted per <see cref="SubjectType"/>.</summary>
    public required Guid SubjectId { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the role held.</summary>
    public required string Role { get; init; }

    /// <summary>Gets who granted it.</summary>
    public required PrincipalId GrantedBy { get; init; }

    /// <summary>Gets when it was granted.</summary>
    public required DateTimeOffset GrantedAt { get; init; }
}
