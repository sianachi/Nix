using Nix.Core.Items;

namespace Nix.Api.Features.Items;

/// <summary>
/// Maps a domain item onto the shape the contract publishes.
/// </summary>
/// <remarks>
/// The one interesting line is the title. The item table has no title column - a name is one of
/// the schema-driven properties an item carries - and the API promotes it to a first-class field
/// because every client needs it to render a row. This is where that promotion happens, and it is
/// the only place it should.
/// </remarks>
internal static class ItemMapping
{
    /// <summary>Maps one item.</summary>
    /// <param name="item">The domain item.</param>
    /// <returns>The published shape.</returns>
    internal static ItemResponse ToResponse(Item item)
    {
        ArgumentNullException.ThrowIfNull(item);

        return new ItemResponse(
            item.Id.Value,
            item.WorkspaceId.Value,
            item.ParentId?.Value,
            item.Type,
            ItemProperties.ReadTitle(item.Properties),
            item.Seq,
            ToWireName(item.LifecycleState),
            item.CreatedAt,
            item.LastModifiedAt);
    }

    /// <summary>
    /// The lifecycle state's wire name.
    /// </summary>
    /// <remarks>
    /// Spelled out rather than lower-casing the enum name, so renaming a member in C# cannot
    /// silently change what clients receive.
    /// </remarks>
    private static string ToWireName(ItemLifecycleState state) => state switch
    {
        ItemLifecycleState.Active => "active",
        ItemLifecycleState.Deleted => "deleted",
        ItemLifecycleState.Purged => "purged",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown lifecycle state."),
    };
}
