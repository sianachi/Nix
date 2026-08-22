using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Views;

/// <summary>
/// What a container's <c>views</c> column says: the views it offers, and which one opens.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <param name="Default">
/// The id of the view that opens, or <see langword="null"/> for the item's own document.
/// </param>
public sealed record StoredViews(ImmutableArray<ViewDefinition> Views, string? Default)
{
    /// <summary>A container that has said nothing.</summary>
    public static readonly StoredViews None = new([], null);

    /// <summary>
    /// What actually opens, given what is stored and what still exists.
    /// </summary>
    /// <returns>
    /// The stored view's id, or <see cref="ViewDefinitionsJson.DocumentView"/> for the body.
    /// </returns>
    /// <remarks>
    /// A default naming a view that has since been deleted resolves to the document rather than to
    /// nothing. Falling back to the first view instead would mean deleting a view silently promoted
    /// whichever one happened to be first, which is a different item opening than the one anybody
    /// chose.
    /// </remarks>
    public string Resolve()
    {
        if (Default is not { } id)
        {
            return ViewDefinitionsJson.DocumentView;
        }

        foreach (var view in Views)
        {
            if (string.Equals(view.Id, id, StringComparison.Ordinal))
            {
                return id;
            }
        }

        return ViewDefinitionsJson.DocumentView;
    }
}

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

    /// <summary>
    /// What "open on the item's own body" is called, rather than on one of its child views.
    /// </summary>
    /// <remarks>
    /// A reserved view id. An item's body and its views are two different axes - the body is the
    /// item's own content and a view renders its children - but only one of them is on screen at a
    /// time, so one field names the winner. Reserving the word is what stops a view whose name
    /// slugs to "document" from colliding with it; <c>SetContainerViews</c> refuses that id.
    /// </remarks>
    public const string DocumentView = "document";

    /// <summary>How many views one container may offer.</summary>
    /// <remarks>
    /// A switcher is a row of names. Past a dozen it stops being one, and the container wants
    /// splitting rather than a scrolling switcher.
    /// </remarks>
    public const int MaximumViews = 12;

    private const string ViewsKey = "views";
    private const string DefaultKey = "default";
    private const string IdKey = "id";
    private const string NameKey = "name";
    private const string KindKey = "kind";
    private const string ColumnsKey = "columns";
    private const string GroupByKey = "groupBy";
    private const string GroupOrderKey = "groupOrder";
    private const string DatePropertyKey = "dateProperty";
    private const string EndDatePropertyKey = "endDateProperty";
    private const string CoverPropertyKey = "coverProperty";
    private const string CardSizeKey = "cardSize";
    private const string MeasureKey = "measure";
    private const string MeasurePropertyKey = "measureProperty";
    private const string ModeKey = "mode";
    private const string SortByKey = "sortBy";
    private const string SortDescendingKey = "sortDescending";
    private const string FiltersKey = "filters";
    private const string FilterPropertyKey = "property";
    private const string FilterOperatorKey = "operator";
    private const string FilterValueKey = "value";
    private const string CompanionViewIdKey = "companionViewId";
    private const string CompanionPlacementKey = "companionPlacement";
    private const string InteractiveFormKey = "interactiveForm";
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Reads a stored view set.
    /// </summary>
    /// <param name="json">The stored JSON, or <see langword="null"/> when the container has none.</param>
    /// <returns>The views and the default, empty when there is nothing usable.</returns>
    /// <remarks>
    /// Never throws. A malformed view set costs a container its switcher; it must not cost the
    /// container its children.
    /// </remarks>
    public static StoredViews Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return StoredViews.None;
        }

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return StoredViews.None;
        }

        if (root is not JsonObject document || document[ViewsKey] is not JsonArray stored)
        {
            return StoredViews.None;
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

        // Read as written, not validated here: a default naming a view that no longer exists is a
        // resolution question rather than a parse failure, and StoredViews.Resolve answers it.
        return new StoredViews(views.ToImmutable(), ReadString(document[DefaultKey]));
    }

    /// <summary>
    /// Writes a view set for storage.
    /// </summary>
    /// <param name="views">The views.</param>
    /// <param name="defaultView">
    /// The id of the view that should open, or <see langword="null"/> for the item's document.
    /// </param>
    /// <returns>The JSON to store, or <see langword="null"/> when there are none.</returns>
    /// <remarks>
    /// Null rather than an empty document for an empty set, so a container that offers no views
    /// stores nothing at all - the column reads the same as it did before anybody configured one.
    /// </remarks>
    public static string? Write(ImmutableArray<ViewDefinition> views, string? defaultView = null)
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

            // Behind the same null guard as every other per-kind field: a stored calendar carries no
            // endDateProperty at all rather than an explicit null, so the column stays small and a
            // later reader never has to tell an absent field from a deliberately cleared one.
            if (view.EndDateProperty is not null)
            {
                entry[EndDatePropertyKey] = view.EndDateProperty;
            }

            if (view.CoverProperty is not null)
            {
                entry[CoverPropertyKey] = view.CoverProperty;
            }

            if (view.Mode is not null)
            {
                entry[ModeKey] = view.Mode;
            }

            if (view.Measure is not null)
            {
                entry[MeasureKey] = view.Measure;
            }

            if (view.MeasureProperty is not null)
            {
                entry[MeasurePropertyKey] = view.MeasureProperty;
            }

            if (view.CardSize is not null)
            {
                entry[CardSizeKey] = view.CardSize;
            }

            if (view.SortBy is not null)
            {
                entry[SortByKey] = view.SortBy;
            }

            // The same null-guard shape as every other per-kind field: a view with no filters
            // stores no key at all, so a later reader never has to tell absent from empty.
            if (!view.Filters.IsDefaultOrEmpty)
            {
                var filters = new JsonArray();
                foreach (var rule in view.Filters)
                {
                    filters.Add(new JsonObject
                    {
                        [FilterPropertyKey] = rule.Property,
                        [FilterOperatorKey] = rule.Operator,
                        [FilterValueKey] = rule.Value,
                    });
                }

                entry[FiltersKey] = filters;
            }

            if (view.CompanionViewId is not null)
            {
                entry[CompanionViewIdKey] = view.CompanionViewId;
                entry[CompanionPlacementKey] = view.CompanionPlacement;
            }

            if (view.InteractiveForm is not null)
            {
                entry[InteractiveFormKey] = JsonSerializer.SerializeToNode(view.InteractiveForm, WebJson);
            }

            stored.Add(entry);
        }

        var document = new JsonObject { [ViewsKey] = stored };

        // Only written when it names a view that exists. "document" is what an absent default
        // already means, so storing it would be a second spelling of the same thing.
        if (defaultView is { } id && id.Length > 0 && !string.Equals(id, DocumentView, StringComparison.Ordinal))
        {
            foreach (var view in views)
            {
                if (string.Equals(view.Id, id, StringComparison.Ordinal))
                {
                    document[DefaultKey] = id;
                    break;
                }
            }
        }

        return document.ToJsonString();
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
            view[SortDescendingKey] is JsonValue flag && flag.TryGetValue(out bool value) && value,
            ReadString(view[ModeKey]),
            ReadString(view[CoverPropertyKey]),
            ReadString(view[EndDatePropertyKey]),
            ReadCardSize(view[CardSizeKey]),
            ReadFilters(view[FiltersKey]),
            ReadString(view[CompanionViewIdKey]),
            ReadString(view[CompanionPlacementKey]),
            ReadInteractiveForm(view[InteractiveFormKey]),
            ReadMeasure(view[MeasureKey]),
            ReadString(view[MeasurePropertyKey]));
    }

    private static InteractiveFormDefinition? ReadInteractiveForm(JsonNode? node)
    {
        try
        {
            return node?.Deserialize<InteractiveFormDefinition>(WebJson);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Reads stored filter rules, dropping a malformed entry without costing the view.
    /// </summary>
    /// <remarks>
    /// The reader's usual contract - a malformed field is a malformed field, not a dropped
    /// switcher entry - with one sharper guarantee downstream: a dropped rule can only ever
    /// <em>widen</em> a query, so the execution endpoint re-validates the surviving set against
    /// <see cref="QueryOperators"/> and refuses to run one that no longer passes. Fail-soft here,
    /// fail-closed where the rows are.
    /// </remarks>
    private static ImmutableArray<FilterRule> ReadFilters(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return [];
        }

        var rules = ImmutableArray.CreateBuilder<FilterRule>(array.Count);
        foreach (var entry in array)
        {
            if (entry is not JsonObject rule)
            {
                continue;
            }

            var property = ReadString(rule[FilterPropertyKey]);
            var @operator = ReadString(rule[FilterOperatorKey]);
            var value = ReadString(rule[FilterValueKey]);

            if (property is { Length: > 0 } && @operator is { Length: > 0 } && value is not null)
            {
                rules.Add(new FilterRule(property, @operator, value));
            }
        }

        return rules.ToImmutable();
    }

    /// <summary>
    /// Reads a stored card size, dropping a value this build does not define.
    /// </summary>
    /// <remarks>
    /// The write path refuses an invalid size outright, so one in the column can only have been put
    /// there by some other writer. Fail closed to null - the gallery draws medium - rather than
    /// passing a token downstream that no renderer and no published contract has a meaning for.
    /// Costing the size, never the view: the reader's contract is that a malformed field is a
    /// malformed field, not a dropped switcher entry.
    /// </remarks>
    /// <summary>
    /// Reads a chart's measure, defaulting anything unrecognised to absent.
    /// </summary>
    /// <remarks>
    /// Defaulted rather than refused on the read path, unlike a card size: absent already means
    /// "count", so a measure a newer build wrote costs an older one the total and not the chart.
    /// The write path refuses an unknown value, which is where somebody can be told.
    /// </remarks>
    private static string? ReadMeasure(JsonNode? node) =>
        ReadString(node) is { } measure && ChartMeasures.IsValid(measure) ? measure : null;

    private static string? ReadCardSize(JsonNode? node) =>
        ReadString(node) is { } size && GalleryCardSizes.IsValid(size) ? size : null;

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
