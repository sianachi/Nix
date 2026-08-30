using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record AcceptWorkspaceInvitation(WorkspaceId WorkspaceId, Guid InvitationId) : ICommand<bool>;

public sealed class AcceptWorkspaceInvitationHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<AcceptWorkspaceInvitation, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        AcceptWorkspaceInvitation command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await store.AcceptInvitationAsync(
            command.WorkspaceId, command.InvitationId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false)
            ? Result.Success(true)
            : Result.Failure<bool>(WorkspaceErrors.NotFound());
    }
}
