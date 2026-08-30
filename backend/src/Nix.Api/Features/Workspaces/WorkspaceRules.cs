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
    internal static NixError HumansOnly() =>
        new("workspaces.human_required", "Only an active human principal can create a workspace.");
}
