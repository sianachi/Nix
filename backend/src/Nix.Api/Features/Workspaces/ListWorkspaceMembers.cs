using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ListWorkspaceMembers(WorkspaceId WorkspaceId, DateTimeOffset? After,
    string? AfterSubjectType, Guid? AfterId, int Limit) : IQuery<IReadOnlyList<WorkspaceMemberSnapshot>>;

public sealed class ListWorkspaceMembersHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<ListWorkspaceMembers, IReadOnlyList<WorkspaceMemberSnapshot>>
{
    public ValueTask<IReadOnlyList<WorkspaceMemberSnapshot>> HandleAsync(
        ListWorkspaceMembers query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ListMembersAsync(query.WorkspaceId, query.After, query.AfterSubjectType,
            query.AfterId, query.Limit, cancellationToken);
    }
}
