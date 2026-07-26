using Nix.Core.Items;
using Nix.Core.Tenancy;

namespace Nix.Core.Authorization;

/// <summary>
/// One access control entry: a role granted to or refused from one subject, on one item, and by
/// inheritance on that item's descendants.
/// </summary>
/// <remarks>
/// <para>
/// Entries are inherited down the tree rather than copied to it. A grant on a folder covers
/// everything beneath it because resolution walks the closure table, not because rows were written
/// per descendant - so moving a subtree changes what applies to it without rewriting anything.
/// </para>
/// <para>
/// The resolution order these rows feed is fixed and lives in one place in the authorization goal:
/// an explicit deny anywhere in the chain refuses; otherwise the nearest entry by closure depth
/// wins; ties break towards principal over group; <see cref="BreaksInheritance"/> halts the upward
/// walk; the workspace role acts as a chain-root allow; and a tenant admin override is permitted
/// but always audited.
/// </para>
/// </remarks>
public sealed class AclEntry
{
    /// <summary>Gets the entry's identifier.</summary>
    public required AclEntryId Id { get; init; }

    /// <summary>Gets the item the entry is attached to.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the workspace the item belongs to.
    /// </summary>
    /// <remarks>
    /// <b>Denormalized from the item, and never an authorization filter source.</b> It is here so
    /// workspace-scoped reads of this table stay local to one index, but nothing constrains it to
    /// agree with <see cref="Items.Item.WorkspaceId"/> - the item's own column is the authority.
    /// Permission SQL that filtered on this one would return a different answer if the two ever
    /// drifted, which is a silent authorization bug rather than a visible data one.
    /// </remarks>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets whether the subject is a principal or a group.</summary>
    public required SubjectType SubjectType { get; init; }

    /// <summary>Gets the subject's identifier, interpreted per <see cref="SubjectType"/>.</summary>
    public required Guid SubjectId { get; init; }

    /// <summary>
    /// Gets the role granted or refused.
    /// </summary>
    /// <remarks>
    /// Text in M0. The vocabulary and its ordering belong to the authorization goal.
    /// </remarks>
    public required string Role { get; init; }

    /// <summary>Gets whether the entry grants or refuses.</summary>
    public required AclEffect Effect { get; init; }

    /// <summary>
    /// Gets whether resolution stops climbing at this item.
    /// </summary>
    /// <remarks>
    /// Set on the item whose permissions are being detached from its parents, which is how a
    /// folder is shared with someone who cannot see anything above it.
    /// </remarks>
    public required bool BreaksInheritance { get; init; }
}
