using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record OpenDailyNote(WorkspaceId WorkspaceId, string Date) : ICommand<Guid>;

public sealed class OpenDailyNoteHandler(
    WorkspaceAdministrationStore store,
    IPermissionResolver permissions,
    TimeProvider clock) : ICommandHandler<OpenDailyNote, Guid>
{
    public async ValueTask<Result<Guid>> HandleAsync(OpenDailyNote command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!DateOnly.TryParseExact(command.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsed)
            || parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != command.Date)
        {
            return Result.Failure<Guid>(new NixError(
                "workspaces.invalid_daily_date", "The daily note date must be canonical yyyy-MM-dd."));
        }

        if (!await permissions.CanWriteWorkspaceAsync(command.WorkspaceId, cancellationToken)
                .ConfigureAwait(false))
        {
            return Result.Failure<Guid>(WorkspaceErrors.NotFound());
        }

        var rootId = DeterministicProvisioningId.DailyNotesRoot(command.WorkspaceId);
        var itemId = DeterministicProvisioningId.DatedDailyNote(command.WorkspaceId, command.Date);
        var opened = await store.OpenDailyNoteAsync(
            command.WorkspaceId, rootId, itemId, command.Date, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);
        return opened is { } id ? Result.Success(id) : Result.Failure<Guid>(WorkspaceErrors.NotFound());
    }
}
