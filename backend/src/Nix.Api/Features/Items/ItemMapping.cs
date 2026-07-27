using System.Text.Json;
using System.Text.Json.Nodes;
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
    /// <param name="hasChildren">
    /// Whether it has children of its own. Required rather than defaulted: the tree draws an expand
    /// control from it, and a default would quietly make every caller that forgot say "no children"
    /// - which looks like a working answer and is not.
    /// </param>
    /// <returns>The published shape.</returns>
    internal static ItemResponse ToResponse(Item item, bool hasChildren)
    {
        ArgumentNullException.ThrowIfNull(item);

        return new ItemResponse(
            item.Id.Value,
            item.WorkspaceId.Value,
            item.ParentId?.Value,
            item.Type,
            ItemProperties.ReadTitle(item.Properties),
            hasChildren,
            item.Seq,
            ToWireName(item.LifecycleState),
            ReadProperties(item.Properties),
            item.CreatedAt,
            item.LastModifiedAt);
    }

    /// <summary>
    /// Reads the property bag, tolerating anything.
    /// </summary>
    /// <remarks>
    /// A bag that will not parse reads as empty rather than failing the request that listed it.
    /// Property values are client-influenced data and a malformed one is a display problem; a
    /// listing that returned 500 because one of fifty items had a bad bag would be the worse
    /// outcome by a wide margin.
    /// </remarks>
    private static JsonObject ReadProperties(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return [];
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
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
