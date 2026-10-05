using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Query;

/// <summary>
/// One item a saved query matched, with enough of its surroundings to say where it lives.
/// </summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="ContainerId">Its parent, or <see langword="null"/> at a workspace root.</param>
/// <param name="ContainerTitle">
/// The parent's title, or <see langword="null"/>. Carried because a cross-container result list
/// is unreadable without saying which container each row came from - the calendar's own lesson.
/// </param>
/// <param name="Title">The item's title, or <see langword="null"/> when it has none.</param>
/// <param name="Type">The item's body kind.</param>
/// <param name="PropertiesJson">The property bag exactly as stored, for the contract to parse.</param>
public sealed record QueryResultItem(
    ItemId Id,
    WorkspaceId WorkspaceId,
    ItemId? ContainerId,
    string? ContainerTitle,
    string? Title,
    string Type,
    string? PropertiesJson);

/// <summary>
/// What a saved query answered: the rows, and whether the ceiling cut them.
/// </summary>
/// <param name="Items">The matches, in the statement's stable order.</param>
/// <param name="Truncated">
/// Whether more rows matched than the ceiling allowed. The honest-state field: a list that was
/// cut and does not say so reads as a list that ended.
/// </param>
public sealed record QueryResults(IReadOnlyList<QueryResultItem> Items, bool Truncated)
{
    /// <summary>A query that matched nothing.</summary>
    public static readonly QueryResults Empty = new([], false);
}
