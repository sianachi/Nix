using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ChangeWorkspaceMemberRole(WorkspaceId WorkspaceId, PrincipalId PrincipalId, string Role)
    : ICommand<WorkspaceMemberSnapshot>;

public sealed class ChangeWorkspaceMemberRoleHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<ChangeWorkspaceMemberRole, WorkspaceMemberSnapshot>
{
    public async ValueTask<Result<WorkspaceMemberSnapshot>> HandleAsync(
        ChangeWorkspaceMemberRole command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!WorkspaceAdministrationRules.TryAssignableRole(command.Role, out var role))
        {
            return Result.Failure<WorkspaceMemberSnapshot>(WorkspaceAdministrationErrors.InvalidRole());
        }
        var changed = await store.ChangeMemberRoleAsync(command.WorkspaceId, command.PrincipalId,
            role, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        if (!changed)
        {
            var existing = await store.FindPrincipalMemberAsync(
                command.WorkspaceId, command.PrincipalId, cancellationToken).ConfigureAwait(false);
            return existing is null ? Result.Failure<WorkspaceMemberSnapshot>(WorkspaceErrors.NotFound())
                : Result.Failure<WorkspaceMemberSnapshot>(WorkspaceAdministrationErrors.ProtectedOwner());
        }
        var member = await store.FindPrincipalMemberAsync(
            command.WorkspaceId, command.PrincipalId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The changed workspace member could not be read back.");
        return Result.Success(member);
    }
}
