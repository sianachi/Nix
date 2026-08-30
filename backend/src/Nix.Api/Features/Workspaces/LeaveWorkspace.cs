using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record LeaveWorkspace(WorkspaceId WorkspaceId) : ICommand<bool>;

public sealed class LeaveWorkspaceHandler(WorkspaceAdministrationStore store, INixSessionContextAccessor session)
    : ICommandHandler<LeaveWorkspace, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        LeaveWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var principal = session.Current?.PrincipalId
            ?? throw new InvalidOperationException("No session context was established.");
        var changed = await store.RemoveMemberAsync(
            command.WorkspaceId, principal, true, cancellationToken).ConfigureAwait(false);
        if (changed)
        {
            return Result.Success(true);
        }
        var existing = await store.FindPrincipalMemberAsync(
            command.WorkspaceId, principal, cancellationToken).ConfigureAwait(false);
        return existing is null ? Result.Failure<bool>(WorkspaceErrors.NotFound())
            : Result.Failure<bool>(WorkspaceAdministrationErrors.ProtectedOwner());
    }
}
