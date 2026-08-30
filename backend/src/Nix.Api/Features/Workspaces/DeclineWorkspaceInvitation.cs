using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record DeclineWorkspaceInvitation(WorkspaceId WorkspaceId, Guid InvitationId) : ICommand<bool>;

public sealed class DeclineWorkspaceInvitationHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<DeclineWorkspaceInvitation, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        DeclineWorkspaceInvitation command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await store.DeclineInvitationAsync(
            command.WorkspaceId, command.InvitationId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false)
            ? Result.Success(true)
            : Result.Failure<bool>(WorkspaceErrors.NotFound());
    }
}
