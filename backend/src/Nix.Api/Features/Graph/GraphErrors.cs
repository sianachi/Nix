using Nix.Domain.Primitives;

namespace Nix.Features.Graph;

/// <summary>
/// The expected failures of the graph feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// Declared once here rather than constructed at each call site, because the code is the part
/// clients branch on. The literals live on <see cref="GraphEndpoints"/>, which is where the status
/// mapping reads them, so the guarantee this class exists to give does not depend on two files
/// agreeing about a string.
/// </remarks>
public static class GraphErrors
{
    /// <summary>No such workspace, or the caller cannot see it.</summary>
    /// <remarks>
    /// Deliberately the same code the workspaces feature uses. Asking for a workspace's graph is
    /// asking for a workspace, and a client that already handles "that workspace is not visible"
    /// should not need a second branch because the fact arrived through a different route.
    /// </remarks>
    public static NixError WorkspaceNotFound(string detail) =>
        new(GraphEndpoints.WorkspaceNotFoundCode, detail);
}
