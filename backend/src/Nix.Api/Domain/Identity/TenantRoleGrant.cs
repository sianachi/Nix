using Nix.Domain.Authorization;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>
/// A tenant-wide role held by a principal or a group: the outermost of the three authorization
/// layers.
/// </summary>
/// <remarks>
/// <para>
/// Named <c>TenantRoleGrant</c> rather than <c>TenantRole</c> because the row is the act of
/// granting, not the role itself. The distinction matters once roles gain definitions of their
/// own.
/// </para>
/// <para>
/// <see cref="Role"/> is text in M0 and deliberately unconstrained. The role vocabulary and its
/// precedence are the authorization goal's to define, and a <c>CHECK</c> constraint written now
/// would be a guess that a later migration has to undo. The column exists; its meaning arrives
/// with the resolver that reads it.
/// </para>
/// </remarks>
public sealed class TenantRoleGrant
{
    /// <summary>Gets the tenant the role is held in.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets whether the role is held by a principal or a group.</summary>
    public required SubjectType SubjectType { get; init; }

    /// <summary>Gets the holder's identifier, interpreted per <see cref="SubjectType"/>.</summary>
    public required Guid SubjectId { get; init; }

    /// <summary>Gets the role held.</summary>
    public required string Role { get; init; }

    /// <summary>Gets who granted it.</summary>
    public required PrincipalId GrantedBy { get; init; }

    /// <summary>Gets when it was granted.</summary>
    public required DateTimeOffset GrantedAt { get; init; }
}
