using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Schedules irreversible deletion of an already archived workspace.</summary>
public sealed record PurgeWorkspace(WorkspaceId WorkspaceId) : ICommand<bool>;

public sealed class PurgeWorkspaceHandler(
    WorkspaceAdministrationStore store,
    IWorkerJobStore jobs,
    INixSessionContextAccessor session,
    TimeProvider clock) : ICommandHandler<PurgeWorkspace, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(PurgeWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await store.BeginPurgeAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(WorkspaceAdministrationErrors.PurgeRefused());
        }

        var keys = await store.ListPurgeObjectKeysAsync(command.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        var context = session.Current
            ?? throw new InvalidOperationException("No session context was established for workspace purge.");
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            context.TenantId,
            context.PrincipalId,
            command.WorkspaceId,
            "workspace-purge",
            command.WorkspaceId.Value,
            clock.GetUtcNow(),
            keys,
            cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}
