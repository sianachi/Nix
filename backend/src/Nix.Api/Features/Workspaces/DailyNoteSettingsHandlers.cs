using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Reads a workspace's effective daily-note settings.</summary>
/// <param name="WorkspaceId">The workspace.</param>
public sealed record GetDailyNoteSettings(WorkspaceId WorkspaceId) : IQuery<DailyNoteSettings?>;

/// <summary>Handles <see cref="GetDailyNoteSettings"/>.</summary>
/// <remarks>
/// The read is permission-filtered inside the statement, so a workspace the caller cannot see comes
/// back as null and is reported as not found, like every other workspace read.
/// </remarks>
public sealed class GetDailyNoteSettingsHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<GetDailyNoteSettings, DailyNoteSettings?>
{
    /// <inheritdoc />
    public ValueTask<DailyNoteSettings?> HandleAsync(
        GetDailyNoteSettings query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ReadDailyNoteSettingsAsync(query.WorkspaceId, cancellationToken);
    }
}

/// <summary>Replaces a workspace's daily-note settings.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="Enabled">Whether daily notes are available.</param>
/// <param name="Folders">The folder mode name.</param>
/// <param name="TitleFormat">The title format name.</param>
/// <param name="Template">The template Markdown, or null for none.</param>
/// <param name="RolloverHour">The rollover hour.</param>
/// <param name="ShowOnCalendar">Whether a client shows notes on the calendar.</param>
public sealed record SaveDailyNoteSettings(
    WorkspaceId WorkspaceId,
    bool Enabled,
    string? Folders,
    string? TitleFormat,
    string? Template,
    int RolloverHour,
    bool ShowOnCalendar) : ICommand<DailyNoteSettings>;

/// <summary>Handles <see cref="SaveDailyNoteSettings"/>.</summary>
/// <remarks>
/// Who may save is decided by the statement - the rename rule plus the personal owner - not by a
/// handler check, so an unauthorised caller and a missing workspace are the same not-found.
/// </remarks>
public sealed class SaveDailyNoteSettingsHandler(WorkspaceAdministrationStore store)
    : ICommandHandler<SaveDailyNoteSettings, DailyNoteSettings>
{
    /// <inheritdoc />
    public async ValueTask<Result<DailyNoteSettings>> HandleAsync(
        SaveDailyNoteSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var created = DailyNoteSettings.Create(
            command.Enabled, command.Folders, command.TitleFormat, command.Template,
            command.RolloverHour, command.ShowOnCalendar);
        if (!created.IsSuccess)
        {
            return created;
        }

        var settings = created.Value;
        return await store.SaveDailyNoteSettingsAsync(command.WorkspaceId, settings, cancellationToken)
            .ConfigureAwait(false)
            ? Result.Success(settings)
            : Result.Failure<DailyNoteSettings>(WorkspaceErrors.NotFound());
    }
}
