using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ListWorkspaceInvitations(WorkspaceId WorkspaceId, DateTimeOffset? After,
    Guid? AfterId, int Limit) : IQuery<IReadOnlyList<WorkspaceInvitationSnapshot>>;

public sealed class ListWorkspaceInvitationsHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<ListWorkspaceInvitations, IReadOnlyList<WorkspaceInvitationSnapshot>>
{
    public ValueTask<IReadOnlyList<WorkspaceInvitationSnapshot>> HandleAsync(
        ListWorkspaceInvitations query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ListInvitationsAsync(query.WorkspaceId, query.After, query.AfterId,
            query.Limit, cancellationToken);
    }
}
