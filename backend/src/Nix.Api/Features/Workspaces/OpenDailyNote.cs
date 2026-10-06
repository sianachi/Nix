using System.Diagnostics;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Opens, creating when needed, the dated daily note of a workspace.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="Date">The canonical <c>yyyy-MM-dd</c> day.</param>
public sealed record OpenDailyNote(WorkspaceId WorkspaceId, string Date) : ICommand<DailyNoteOpened>;

/// <summary>The note a daily-note open resolved to.</summary>
/// <param name="ItemId">The note's identifier.</param>
/// <param name="Created">True only when this request inserted the note, so a client inserts its template once.</param>
public sealed record DailyNoteOpened(Guid ItemId, bool Created);

/// <summary>Handles <see cref="OpenDailyNote"/>.</summary>
/// <remarks>
/// A note's identifier comes from the workspace and the date alone, whatever the workspace's
/// settings say, so settings only shape notes created after they change: an existing note is
/// returned where it is, with no move and no retitle. That is a deliberate owner decision, and it is
/// what keeps opening a day idempotent across settings changes.
/// <para>
/// A day has a short sequence of candidate identifiers, generation 0 being the original one. A
/// purged note, or one moved to another workspace, retires its identifier and the day's next open
/// creates a fresh note under the next generation; the purged row and its audit stay untouched.
/// </para>
/// </remarks>
public sealed class OpenDailyNoteHandler(
    WorkspaceAdministrationStore store,
    IPermissionResolver permissions,
    TimeProvider clock) : ICommandHandler<OpenDailyNote, DailyNoteOpened>
{
    /// <summary>How many identifiers one day can move through before it refuses to open.</summary>
    private const int NoteGenerations = 64;

    /// <inheritdoc />
    public async ValueTask<Result<DailyNoteOpened>> HandleAsync(OpenDailyNote command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!DateOnly.TryParseExact(command.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsed)
            || parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != command.Date)
        {
            return Result.Failure<DailyNoteOpened>(new NixError(
                "workspaces.invalid_daily_date", "The daily note date must be canonical yyyy-MM-dd."));
        }

        if (!await permissions.CanWriteWorkspaceAsync(command.WorkspaceId, cancellationToken)
                .ConfigureAwait(false))
        {
            return Result.Failure<DailyNoteOpened>(WorkspaceErrors.NotFound());
        }

        var rootId = DeterministicProvisioningId.DailyNotesRoot(command.WorkspaceId);
        var candidateIds = new Guid[NoteGenerations];
        for (var generation = 0; generation < candidateIds.Length; generation++)
        {
            candidateIds[generation] = DeterministicProvisioningId.DatedDailyNote(
                command.WorkspaceId, command.Date, generation);
        }

        var opening = await store.OpenDailyNoteAsync(
            command.WorkspaceId, rootId, candidateIds, parsed, command.Date, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);
        return opening.Outcome switch
        {
            DailyNoteOutcome.Opened => Result.Success(new DailyNoteOpened(opening.ItemId, opening.Created)),
            DailyNoteOutcome.Disabled => Result.Failure<DailyNoteOpened>(WorkspaceErrors.DailyNotesDisabled()),
            DailyNoteOutcome.RootUnavailable =>
                Result.Failure<DailyNoteOpened>(WorkspaceErrors.DailyNotesRootUnavailable()),
            DailyNoteOutcome.InTrash => Result.Failure<DailyNoteOpened>(WorkspaceErrors.DailyNoteInTrash()),
            DailyNoteOutcome.Locked => Result.Failure<DailyNoteOpened>(WorkspaceErrors.DailyNoteLocked()),
            DailyNoteOutcome.NotAuthorized => Result.Failure<DailyNoteOpened>(WorkspaceErrors.NotFound()),
            DailyNoteOutcome.Unavailable => Result.Failure<DailyNoteOpened>(WorkspaceErrors.DailyNoteUnavailable()),
            _ => throw new UnreachableException($"Unmapped daily-note outcome {opening.Outcome}."),
        };
    }
}
