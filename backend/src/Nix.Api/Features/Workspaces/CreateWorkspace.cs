using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record CreateWorkspace(string Name) : ICommand<WorkspaceSnapshot>;

public sealed class CreateWorkspaceHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<CreateWorkspace, WorkspaceSnapshot>
{
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        CreateWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var name = WorkspaceRules.NormalizeName(command.Name);
        if (name is null)
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.InvalidName());
        }

        var id = WorkspaceId.Create();
        if (!await store.CreateAsync(id, name, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.HumansOnly());
        }

        var created = await store.FindAsync(id, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The newly created workspace could not be read back.");
        return Result.Success(created);
    }
}
