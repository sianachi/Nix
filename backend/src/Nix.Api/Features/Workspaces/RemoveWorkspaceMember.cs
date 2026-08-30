using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record RemoveWorkspaceMember(WorkspaceId WorkspaceId, PrincipalId PrincipalId) : ICommand<bool>;

public sealed class RemoveWorkspaceMemberHandler(WorkspaceAdministrationStore store)
    : ICommandHandler<RemoveWorkspaceMember, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        RemoveWorkspaceMember command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var changed = await store.RemoveMemberAsync(
            command.WorkspaceId, command.PrincipalId, false, cancellationToken).ConfigureAwait(false);
        if (changed)
        {
            return Result.Success(true);
        }
        var existing = await store.FindPrincipalMemberAsync(
            command.WorkspaceId, command.PrincipalId, cancellationToken).ConfigureAwait(false);
        return existing is null ? Result.Failure<bool>(WorkspaceErrors.NotFound())
            : Result.Failure<bool>(WorkspaceAdministrationErrors.ProtectedOwner());
    }
}
