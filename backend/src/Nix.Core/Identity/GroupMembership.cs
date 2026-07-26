using Nix.Core.Tenancy;

namespace Nix.Core.Identity;

/// <summary>
/// One principal's membership of one group.
/// </summary>
/// <remarks>
/// Carries <see cref="TenantId"/> even though it could be derived by joining either side. Every
/// tenant-scoped table holds the tenant on the row itself so its row-level security policy is an
/// indexed equality test rather than a subquery: a policy that joins is evaluated per candidate
/// row, and this table is read on the hot path of every permission decision.
/// </remarks>
public sealed class GroupMembership
{
    /// <summary>Gets the group.</summary>
    public required PrincipalGroupId GroupId { get; init; }

    /// <summary>Gets the member.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets where the membership came from - directory synchronisation or a local assignment.
    /// </summary>
    /// <remarks>
    /// Text rather than an enumeration: provisioning owns this vocabulary and has not been built
    /// yet. Recording the provider's own word for it beats forcing it into two cases now.
    /// </remarks>
    public required string Source { get; init; }
}
