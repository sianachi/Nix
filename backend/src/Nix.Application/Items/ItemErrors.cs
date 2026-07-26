using Nix.Core.Primitives;

namespace Nix.Application.Items;

/// <summary>
/// The expected failures of the item feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// <para>
/// Declared once here rather than constructed at each call site, because the code is the part
/// clients branch on and a typo in one of them is a bug nobody notices until a frontend stops
/// handling a case it used to. The endpoint layer maps these codes onto status codes; it does not
/// invent codes of its own.
/// </para>
/// <para>
/// <b>An item the caller may not read is reported as not found</b>, never as forbidden. The
/// distinction is deliberate and it is a security property: "you may not see this" confirms the
/// thing exists, which is how an outsider enumerates a workspace one identifier at a time.
/// </para>
/// </remarks>
public static class ItemErrors
{
    /// <summary>No such item, or the caller cannot see it.</summary>
    public static NixError NotFound(string detail) => new("items.not_found", detail);

    /// <summary>The requested parent does not exist or is not visible.</summary>
    public static NixError ParentNotFound(string detail) => new("items.parent_not_found", detail);

    /// <summary>The destination of a move is the item itself or one of its descendants.</summary>
    public static NixError WouldCreateCycle(string detail) =>
        new("items.move_would_create_cycle", detail);

    /// <summary>The operation is not valid in the item's current lifecycle state.</summary>
    public static NixError LifecycleConflict(string detail) =>
        new("items.lifecycle_conflict", detail);

    /// <summary>The workspace does not exist or is not visible.</summary>
    public static NixError WorkspaceNotFound(string detail) =>
        new("workspaces.not_found", detail);
}
