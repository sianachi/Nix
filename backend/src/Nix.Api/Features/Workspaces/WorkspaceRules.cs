using Nix.Domain.Primitives;

namespace Nix.Features.Workspaces;

internal static class WorkspaceRules
{
    internal const int MaximumNameLength = 200;

    internal static string? NormalizeName(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) || trimmed.Length > MaximumNameLength ? null : trimmed;
    }
}

internal static class WorkspaceErrors
{
    internal static NixError NotFound() =>
        new(WorkspaceEndpoints.NotFoundCode, "No accessible workspace has that identifier.");
    internal static NixError InvalidName() =>
        new("workspaces.invalid_name", "Workspace names must contain 1 to 200 characters.");
    internal static NixError DailyNotesDisabled() =>
        new("workspaces.daily_notes_disabled", "Daily notes are switched off for this workspace.");
    internal static NixError DailyNotesRootUnavailable() =>
        new("workspaces.daily_notes_root_unavailable",
            "The Daily notes root or a folder under it is unavailable; restore or unlock it to open daily notes.");
    internal static NixError HumansOnly() =>
        new("workspaces.human_required", "Only an active human principal can create a workspace.");
}
