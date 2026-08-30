using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record RevokeWorkspaceInvitation(WorkspaceId WorkspaceId, Guid InvitationId) : ICommand<bool>;

public sealed class RevokeWorkspaceInvitationHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<RevokeWorkspaceInvitation, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        RevokeWorkspaceInvitation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var changed = await store.RevokeInvitationAsync(command.WorkspaceId, command.InvitationId,
            clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        if (changed > 0)
        {
            return Result.Success(true);
        }
        var existing = await store.FindInvitationAsync(
            command.WorkspaceId, command.InvitationId, cancellationToken).ConfigureAwait(false);
        return existing is null ? Result.Failure<bool>(WorkspaceErrors.NotFound())
            : Result.Failure<bool>(WorkspaceAdministrationErrors.InvitationNotPending());
    }
}
