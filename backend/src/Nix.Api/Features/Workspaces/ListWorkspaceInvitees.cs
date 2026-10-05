using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ListWorkspaceInvitees(
    WorkspaceId WorkspaceId,
    PrincipalId? AfterId,
    int Limit) : IQuery<IReadOnlyList<WorkspaceInviteeSnapshot>>;

public sealed class ListWorkspaceInviteesHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<ListWorkspaceInvitees, IReadOnlyList<WorkspaceInviteeSnapshot>>
{
    public ValueTask<IReadOnlyList<WorkspaceInviteeSnapshot>> HandleAsync(
        ListWorkspaceInvitees query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ListInviteesAsync(query.WorkspaceId, query.AfterId, query.Limit, cancellationToken);
    }
}
