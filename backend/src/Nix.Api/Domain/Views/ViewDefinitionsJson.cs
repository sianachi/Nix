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
/// <param name="HideDocument">
/// Whether the item's switcher leaves out its own document tab. Only ever true alongside at least
/// one view: <see cref="ViewDefinitionsJson.Read"/> and <see cref="ViewDefinitionsJson.Write"/> both
/// refuse to carry it for an item with nothing else to show.
/// </param>
/// <remarks>
/// <b>Hiding the document hides a tab and nothing more.</b> It is not an access control: the body
/// is still readable through every body read, search, link and export, and no permission changes.
/// It exists so an item whose views are what matter, a board that should simply open as a board,
/// is not shown a tab for an empty note. Do not mistake it for a privacy feature.
/// </remarks>
public sealed record StoredViews(
    ImmutableArray<ViewDefinition> Views,
    string? Default,
    bool HideDocument = false)
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
    /// chose. The one exception is an item that hides its document tab: there is no document to
    /// open, so the first view opens, which is also what a write would have stored.
    /// </remarks>
    public string Resolve()
    {
        var resolved = ResolveStored();
        return HideDocument
            && Views.Length > 0
            && string.Equals(resolved, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
                ? Views[0].Id
                : resolved;
    }

    private string ResolveStored()
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
    private const string HideDocumentKey = "hideDocument";
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
    private const string LayoutKey = "layout";
    private const string DonePropertyKey = "doneProperty";
    private const string RowByKey = "rowBy";
    private const string MeasureKey = "measure";
    private const string MeasurePropertyKey = "measureProperty";
    private const string ModeKey = "mode";
    private const string SortByKey = "sortBy";
    private const string SortDescendingKey = "sortDescending";
    private const string FiltersKey = "filters";
    private const string FilterPropertyKey = "property";
    private const string FilterOperatorKey = "operator";
    private const string FilterValueKey = "value";
    private const string FilterAnyKey = "any";
    private const string CompanionViewIdKey = "companionViewId";
    private const string CompanionPlacementKey = "companionPlacement";
    private const string InteractiveFormKey = "interactiveForm";
    private const string SortsKey = "sorts";
    private const string SortPropertyKey = "property";
    private const string SortDescendingFlagKey = "descending";
    private const string CollapsedGroupsKey = "collapsedGroups";
    private const string GroupLimitsKey = "groupLimits";
    private const string GroupLimitGroupKey = "group";
    private const string GroupLimitLimitKey = "limit";
    private const string AggregatesKey = "aggregates";
    private const string AggregatePropertyKey = "property";
    private const string AggregateFunctionKey = "function";
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
        // resolution question rather than a parse failure, and StoredViews.Resolve answers it. The
        // hidden-document flag is the exception that is dropped rather than carried: with no view
        // that survived parsing there is nothing else to show, so the flag cannot stand.
        var hideDocument = views.Count > 0
            && document[HideDocumentKey] is JsonValue hide
            && hide.TryGetValue(out bool hidden)
            && hidden;

        return new StoredViews(views.ToImmutable(), ReadString(document[DefaultKey]), hideDocument);
    }

    /// <summary>
    /// Writes a view set for storage.
    /// </summary>
    /// <param name="views">The views.</param>
    /// <param name="defaultView">
    /// The id of the view that should open, or <see langword="null"/> for the item's document.
    /// </param>
    /// <param name="hideDocument">
    /// Whether the item's own document tab is left out of its switcher. A tab is hidden, not
    /// protected: see <see cref="StoredViews.HideDocument"/>.
    /// </param>
    /// <returns>The JSON to store, or <see langword="null"/> when there are none.</returns>
    /// <remarks>
    /// Null rather than an empty document for an empty set, so a container that offers no views
    /// stores nothing at all - the column reads the same as it did before anybody configured one.
    /// That is also where the hidden-document flag is cleared when the last view goes: an item can
    /// never be left with nothing to show.
    /// <para>
    /// When the document is hidden the stored default is always a view that exists, falling back to
    /// the first in order, because the document is not there to open. The flag is written only when
    /// true, so every existing row stays byte-identical.
    /// </para>
    /// </remarks>
    public static string? Write(
        ImmutableArray<ViewDefinition> views,
        string? defaultView = null,
        bool hideDocument = false)
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

            if (view.Layout is not null)
            {
                entry[LayoutKey] = view.Layout;
            }

            if (view.DoneProperty is not null)
            {
                entry[DonePropertyKey] = view.DoneProperty;
            }

            if (view.RowBy is not null)
            {
                entry[RowByKey] = view.RowBy;
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
                    filters.Add(WriteFilter(rule));
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

            if (!view.HabitWidgets.IsDefaultOrEmpty)
            {
                entry["habitWidgets"] = JsonSerializer.SerializeToNode(view.HabitWidgets, WebJson);
            }

            // The arrangement fields (ADR-0054), behind the same absent-means-empty guard as
            // filters: a view nobody has arranged stores none of these keys.
            if (!view.Sorts.IsDefaultOrEmpty)
            {
                var sorts = new JsonArray();
                foreach (var sort in view.Sorts)
                {
                    sorts.Add(new JsonObject
                    {
                        [SortPropertyKey] = sort.Property,
                        [SortDescendingFlagKey] = sort.Descending,
                    });
                }

                entry[SortsKey] = sorts;
            }

            AddStrings(entry, CollapsedGroupsKey, view.CollapsedGroups);

            if (!view.GroupLimits.IsDefaultOrEmpty)
            {
                var limits = new JsonArray();
                foreach (var limit in view.GroupLimits)
                {
                    limits.Add(new JsonObject
                    {
                        [GroupLimitGroupKey] = limit.Group,
                        [GroupLimitLimitKey] = limit.Limit,
                    });
                }

                entry[GroupLimitsKey] = limits;
            }

            if (!view.Aggregates.IsDefaultOrEmpty)
            {
                var aggregates = new JsonArray();
                foreach (var aggregate in view.Aggregates)
                {
                    aggregates.Add(new JsonObject
                    {
                        [AggregatePropertyKey] = aggregate.Property,
                        [AggregateFunctionKey] = aggregate.Function,
                    });
                }

                entry[AggregatesKey] = aggregates;
            }

            stored.Add(entry);
        }

        var document = new JsonObject { [ViewsKey] = stored };

        // Only written when it names a view that exists. "document" is what an absent default
        // already means, so storing it would be a second spelling of the same thing.
        string? storedDefault = null;
        if (defaultView is { } id && id.Length > 0 && !string.Equals(id, DocumentView, StringComparison.Ordinal))
        {
            foreach (var view in views)
            {
                if (string.Equals(view.Id, id, StringComparison.Ordinal))
                {
                    storedDefault = id;
                    break;
                }
            }
        }

        if (hideDocument)
        {
            storedDefault ??= views[0].Id;
            document[HideDocumentKey] = true;
        }

        if (storedDefault is not null)
        {
            document[DefaultKey] = storedDefault;
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

        // Mirrored on read as well as on write: a writer that stores the column without the view
        // endpoint (a template merge, a document import) may leave the single-key fields naming
        // something other than the list's first key, and every reader of those fields - the query
        // runner, an export - must still order by the primary key.
        return ViewSorting.MirrorPrimary(new ViewDefinition(
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
            ReadString(view[MeasurePropertyKey]),
            ReadHabitWidgets(view["habitWidgets"]),
            ReadLayout(view[LayoutKey]),
            ReadSorts(view[SortsKey]),
            ReadStrings(view[CollapsedGroupsKey]),
            ReadGroupLimits(view[GroupLimitsKey]),
            ReadAggregates(view[AggregatesKey]),
            ReadString(view[DonePropertyKey]),
            ReadString(view[RowByKey])));
    }

    /// <summary>
    /// Reads stored sort keys, dropping a malformed entry or a repeated key without costing the view.
    /// </summary>
    private static ImmutableArray<ViewSort> ReadSorts(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return [];
        }

        var sorts = ImmutableArray.CreateBuilder<ViewSort>(array.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in array)
        {
            if (entry is JsonObject sort
                && ReadString(sort[SortPropertyKey]) is { Length: > 0 } property
                && seen.Add(property))
            {
                var descending = sort[SortDescendingFlagKey] is JsonValue flag
                    && flag.TryGetValue(out bool value)
                    && value;
                sorts.Add(new ViewSort(property, descending));
            }
        }

        return sorts.ToImmutable();
    }

    /// <summary>Reads stored group limits, dropping any entry that is not a positive count.</summary>
    private static ImmutableArray<ViewGroupLimit> ReadGroupLimits(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return [];
        }

        var limits = ImmutableArray.CreateBuilder<ViewGroupLimit>(array.Count);
        foreach (var entry in array)
        {
            if (entry is JsonObject limit
                && ReadString(limit[GroupLimitGroupKey]) is { } group
                && limit[GroupLimitLimitKey] is JsonValue count
                && count.TryGetValue(out int value)
                && value > 0)
            {
                limits.Add(new ViewGroupLimit(group, value));
            }
        }

        return limits.ToImmutable();
    }

    /// <summary>
    /// Reads stored column summaries, dropping a function this build does not define - the footer
    /// loses that column's summary, never the view.
    /// </summary>
    private static ImmutableArray<ViewAggregate> ReadAggregates(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return [];
        }

        var aggregates = ImmutableArray.CreateBuilder<ViewAggregate>(array.Count);
        foreach (var entry in array)
        {
            if (entry is JsonObject aggregate
                && ReadString(aggregate[AggregatePropertyKey]) is { Length: > 0 } property
                && ReadString(aggregate[AggregateFunctionKey]) is { } function
                && ViewAggregateFunctions.IsValid(function))
            {
                aggregates.Add(new ViewAggregate(property, function));
            }
        }

        return aggregates.ToImmutable();
    }

    private static ImmutableArray<HabitWidgetDefinition> ReadHabitWidgets(JsonNode? node)
    {
        try
        {
            return node?.Deserialize<ImmutableArray<HabitWidgetDefinition>>(WebJson) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
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

            // An "any of" group (one level only): its rules are read the same fail-soft way, and
            // a nested group inside one is dropped rather than flattened into a different meaning.
            if (rule[FilterAnyKey] is JsonArray alternatives)
            {
                var inner = ImmutableArray.CreateBuilder<FilterRule>(alternatives.Count);
                foreach (var alternative in alternatives)
                {
                    if (alternative is JsonObject leaf && leaf[FilterAnyKey] is null && ReadLeaf(leaf) is { } read)
                    {
                        inner.Add(read);
                    }
                }

                if (inner.Count > 0)
                {
                    rules.Add(FilterRule.Group(inner.ToImmutable()));
                }

                continue;
            }

            if (ReadLeaf(rule) is { } plain)
            {
                rules.Add(plain);
            }
        }

        return rules.ToImmutable();
    }

    private static FilterRule? ReadLeaf(JsonObject rule)
    {
        var property = ReadString(rule[FilterPropertyKey]);
        var @operator = ReadString(rule[FilterOperatorKey]);
        var value = ReadString(rule[FilterValueKey]);

        return property is { Length: > 0 } && @operator is { Length: > 0 } && value is not null
            ? new FilterRule(property, @operator, value)
            : null;
    }

    /// <summary>Writes one stored rule: a plain condition, or an "any of" group of them.</summary>
    private static JsonObject WriteFilter(FilterRule rule)
    {
        if (!rule.IsGroup)
        {
            return new JsonObject
            {
                [FilterPropertyKey] = rule.Property,
                [FilterOperatorKey] = rule.Operator,
                [FilterValueKey] = rule.Value,
            };
        }

        var alternatives = new JsonArray();
        foreach (var inner in rule.Any)
        {
            alternatives.Add(WriteFilter(inner));
        }

        return new JsonObject { [FilterAnyKey] = alternatives };
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

    private static string? ReadLayout(JsonNode? node) =>
        ReadString(node) is { } layout && DriveLayouts.IsValid(layout) ? layout : null;

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
