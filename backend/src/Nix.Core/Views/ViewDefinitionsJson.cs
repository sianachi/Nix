using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Core.Views;

/// <summary>
/// Reads and writes a container's views as the JSON stored in <c>item.views</c>.
/// </summary>
/// <remarks>
/// The counterpart to the schema reader, and the same seam: views are parsed out of the column
/// here and never handled as raw JSON above it, so ADR-0006 can be revisited without touching a
/// use case.
/// </remarks>
public static class ViewDefinitionsJson
{
    /// <summary>The largest a stored view set may be, matching the column's own bound.</summary>
    public const int MaximumBytes = 32 * 1024;

    /// <summary>How many views one container may offer.</summary>
    /// <remarks>
    /// A switcher is a row of names. Past a dozen it stops being one, and the container wants
    /// splitting rather than a scrolling switcher.
    /// </remarks>
    public const int MaximumViews = 12;

    private const string ViewsKey = "views";
    private const string IdKey = "id";
    private const string NameKey = "name";
    private const string KindKey = "kind";
    private const string ColumnsKey = "columns";
    private const string GroupByKey = "groupBy";
    private const string GroupOrderKey = "groupOrder";
    private const string DatePropertyKey = "dateProperty";
    private const string SortByKey = "sortBy";
    private const string SortDescendingKey = "sortDescending";

    /// <summary>
    /// Reads a stored view set.
    /// </summary>
    /// <param name="json">The stored JSON, or <see langword="null"/> when the container has none.</param>
    /// <returns>The views, empty when there is nothing usable.</returns>
    /// <remarks>
    /// Never throws. A malformed view set costs a container its switcher; it must not cost the
    /// container its children.
    /// </remarks>
    public static ImmutableArray<ViewDefinition> Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return [];
        }

        if (root is not JsonObject document || document[ViewsKey] is not JsonArray stored)
        {
            return [];
        }

        var views = ImmutableArray.CreateBuilder<ViewDefinition>(stored.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var entry in stored)
        {
            var view = ReadView(entry);
            if (view is not null && seen.Add(view.Id))
            {
                views.Add(view);
            }
        }

        return views.ToImmutable();
    }

    /// <summary>
    /// Writes a view set for storage.
    /// </summary>
    /// <param name="views">The views.</param>
    /// <returns>The JSON to store, or <see langword="null"/> when there are none.</returns>
    /// <remarks>
    /// Null rather than an empty document for an empty set, so a container that offers no views
    /// stores nothing at all - the column reads the same as it did before anybody configured one.
    /// </remarks>
    public static string? Write(ImmutableArray<ViewDefinition> views)
    {
        if (views.IsDefaultOrEmpty)
        {
            return null;
        }

        var stored = new JsonArray();
        foreach (var view in views)
        {
            var entry = new JsonObject
            {
                [IdKey] = view.Id,
                [NameKey] = view.Name,
                [KindKey] = ViewKinds.ToText(view.Kind),
                [SortDescendingKey] = view.SortDescending,
            };

            AddStrings(entry, ColumnsKey, view.Columns);
            AddStrings(entry, GroupOrderKey, view.GroupOrder);

            if (view.GroupBy is not null)
            {
                entry[GroupByKey] = view.GroupBy;
            }

            if (view.DateProperty is not null)
            {
                entry[DatePropertyKey] = view.DateProperty;
            }

            if (view.SortBy is not null)
            {
                entry[SortByKey] = view.SortBy;
            }

            stored.Add(entry);
        }

        return new JsonObject { [ViewsKey] = stored }.ToJsonString();
    }

    private static void AddStrings(JsonObject entry, string key, ImmutableArray<string> values)
    {
        if (values.IsDefaultOrEmpty)
        {
            return;
        }

        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(value);
        }

        entry[key] = array;
    }

    private static ViewDefinition? ReadView(JsonNode? entry)
    {
        if (entry is not JsonObject view)
        {
            return null;
        }

        var id = ReadString(view[IdKey]);
        if (id is null || id.Length == 0)
        {
            return null;
        }

        if (!ViewKinds.TryParse(ReadString(view[KindKey]), out var kind))
        {
            return null;
        }

        return new ViewDefinition(
            id,
            ReadString(view[NameKey]) ?? id,
            kind,
            ReadStrings(view[ColumnsKey]),
            ReadString(view[GroupByKey]),
            ReadStrings(view[GroupOrderKey]),
            ReadString(view[DatePropertyKey]),
            ReadString(view[SortByKey]),
            view[SortDescendingKey] is JsonValue flag && flag.TryGetValue(out bool value) && value);
    }

    private static ImmutableArray<string> ReadStrings(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return [];
        }

        var values = ImmutableArray.CreateBuilder<string>(array.Count);
        foreach (var entry in array)
        {
            var text = ReadString(entry);
            if (text is not null && !values.Contains(text, StringComparer.Ordinal))
            {
                values.Add(text);
            }
        }

        return values.ToImmutable();
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
