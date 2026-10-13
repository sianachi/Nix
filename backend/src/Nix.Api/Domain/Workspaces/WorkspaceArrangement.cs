using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Workspaces;

/// <summary>
/// How one person arranges the workspaces they can see: named groups and a pinned list.
/// </summary>
/// <remarks>
/// A personal arrangement, never a tenant-wide one: grouping and pinning grant nothing and change
/// no workspace row, membership or permission. Ids that the person can no longer see are left in
/// the document and filtered by the reader against their current workspace list, so losing access
/// never has to rewrite this row.
/// </remarks>
public sealed class WorkspaceArrangement
{
    public required TenantId TenantId { get; init; }

    public required PrincipalId PrincipalId { get; init; }

    /// <summary>The groups as a JSON document (<see cref="WorkspaceArrangementDocument"/>).</summary>
    public required string GroupsJson { get; init; }

    public required IReadOnlyList<Guid> PinnedWorkspaceIds { get; init; }

    public required long Revision { get; init; }
}
