using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Content;

/// <summary>
/// One principal's personal set of reusable native canvas shapes, available on every canvas they open.
/// </summary>
/// <remarks>
/// <para>
/// Keyed by <see cref="PrincipalId"/> alone, not by workspace or item: a shape library is a drawing
/// tool a person carries with them, the same way a physical stencil is not left behind in one
/// notebook. One row per principal holds the library whole as a single ordered set of native items
/// that the editor's save and insert actions both operate against.
/// </para>
/// <para>
/// A replace, not a log: <see cref="LibraryItemsJson"/> is overwritten wholesale on every save,
/// using complete contents rather than a delta.
/// </para>
/// </remarks>
public sealed class CanvasLibrary
{
    /// <summary>Gets the owning principal. Also the primary key: one library per principal.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the library's contents as a JSON array of native items. Opaque to Core, which stores
    /// and returns it without interpreting editor-specific fields.
    /// </summary>
    public required string LibraryItemsJson { get; init; }

    /// <summary>Gets when the library was last saved.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
