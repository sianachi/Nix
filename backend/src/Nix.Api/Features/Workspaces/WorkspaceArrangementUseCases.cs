using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Domain.Workspaces;
using Nix.Messaging;
using Nix.Serialization;

namespace Nix.Features.Workspaces;

/// <summary>Bounds a person's arrangement: it is their own convenience, never a permission.</summary>
public static class WorkspaceArrangementValidation
{
    /// <summary>The most groups one person may keep.</summary>
    public const int MaximumGroups = 50;

    /// <summary>The most workspaces one person may pin, and the most one group may hold.</summary>
    public const int MaximumWorkspaces = 200;

    /// <summary>The longest group name.</summary>
    public const int MaximumNameLength = 80;

    /// <summary>Gets the document a principal who has never saved an arrangement reads.</summary>
    public static WorkspaceArrangementInput Empty => new([], []);

    /// <summary>
    /// Refuses too many groups or pins, a blank or long name, a repeated group id, and a workspace
    /// listed in two groups or twice in one. Unknown workspace ids are allowed: the reader filters
    /// them against what the person can currently see, so losing access never fails a save.
    /// </summary>
    public static bool IsValid(WorkspaceArrangementInput? input)
    {
        if (input is null || input.Groups is null || input.PinnedWorkspaceIds is null
            || input.Groups.Count > MaximumGroups || input.PinnedWorkspaceIds.Count > MaximumWorkspaces
            || input.PinnedWorkspaceIds.Any(id => id == Guid.Empty)
            || input.PinnedWorkspaceIds.Distinct().Count() != input.PinnedWorkspaceIds.Count)
        {
            return false;
        }

        var groupIds = new HashSet<Guid>();
        var placed = new HashSet<Guid>();
        foreach (var group in input.Groups)
        {
            if (group is null || group.Id == Guid.Empty || !groupIds.Add(group.Id)
                || string.IsNullOrWhiteSpace(group.Name) || group.Name.Length > MaximumNameLength
                || group.WorkspaceIds is null || group.WorkspaceIds.Count > MaximumWorkspaces)
            {
                return false;
            }

            foreach (var workspaceId in group.WorkspaceIds)
            {
                if (workspaceId == Guid.Empty || !placed.Add(workspaceId))
                {
                    return false;
                }
            }
        }

        return true;
    }

    internal static string Serialize(IReadOnlyList<WorkspaceGroupDto> groups) =>
        JsonSerializer.Serialize(groups, WorkspacesJsonContext.Default.IReadOnlyListWorkspaceGroupDto);

    internal static IReadOnlyList<WorkspaceGroupDto> Deserialize(string json)
    {
        try
        {
            return JsonSerializer.Deserialize(json, WorkspacesJsonContext.Default.IReadOnlyListWorkspaceGroupDto) ?? [];
        }
        catch (JsonException)
        {
            // A document this build cannot read costs the groups, never the pins or the row.
            return [];
        }
    }
}

/// <summary>Reads only the session owner's arrangement.</summary>
public sealed class GetWorkspaceArrangementHandler(IWorkspaceArrangementStore store, INixSessionContextAccessor session)
    : IQueryHandler<GetWorkspaceArrangement, WorkspaceArrangementResponse>
{
    /// <inheritdoc />
    public async ValueTask<WorkspaceArrangementResponse> HandleAsync(GetWorkspaceArrangement query, CancellationToken cancellationToken)
    {
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var row = await store.FindAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return row is null
            ? new(0, [], [])
            : new(row.Revision, WorkspaceArrangementValidation.Deserialize(row.GroupsJson), row.PinnedWorkspaceIds);
    }
}

/// <summary>Persists an arrangement using a compare-and-swap revision.</summary>
public sealed class SaveWorkspaceArrangementHandler(IWorkspaceArrangementStore store, INixSessionContextAccessor session)
    : ICommandHandler<SaveWorkspaceArrangement, WorkspaceArrangementResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<WorkspaceArrangementResponse>> HandleAsync(SaveWorkspaceArrangement command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.ExpectedRevision < 0 || command.ExpectedRevision >= 9007199254740991
            || !WorkspaceArrangementValidation.IsValid(command.Arrangement))
        {
            return Result.Failure<WorkspaceArrangementResponse>(new NixError(
                "workspaces.invalid_arrangement",
                "Give every group a name, list each workspace in one group at most, and keep within the limits."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var revision = command.ExpectedRevision + 1;
        var groups = command.Arrangement.Groups.Select(group => group with { Name = group.Name.Trim() }).ToArray();
        var saved = await store.SaveAsync(new WorkspaceArrangement
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            GroupsJson = WorkspaceArrangementValidation.Serialize(groups),
            PinnedWorkspaceIds = command.Arrangement.PinnedWorkspaceIds,
            Revision = revision,
        }, command.ExpectedRevision, cancellationToken).ConfigureAwait(false);
        return saved
            ? Result.Success(new WorkspaceArrangementResponse(revision, groups, command.Arrangement.PinnedWorkspaceIds))
            : Result.Failure<WorkspaceArrangementResponse>(new NixError(
                "workspaces.arrangement_conflict",
                "Your workspace arrangement changed on another device. Reload before saving."));
    }
}
