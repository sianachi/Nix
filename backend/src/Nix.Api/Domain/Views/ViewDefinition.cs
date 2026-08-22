using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>
/// How a container may be looked at.
/// </summary>
/// <remarks>
/// A view is a way of rendering a container's children, not a place in the application. That is
/// why it is stored on the container rather than being a route: "board" is something an item can
/// be shown as, and the same item can be shown as a list a moment later without going anywhere.
/// </remarks>
public enum ViewKind
{
    /// <summary>Rows and columns, one row per child.</summary>
    List = 0,

    /// <summary>Cards grouped into columns by a single-select property.</summary>
    Board = 1,

    /// <summary>Items placed on a month by a date property.</summary>
    Calendar = 2,

    /// <summary>Children as a grid of cards, each optionally showing a cover image.</summary>
    /// <remarks>
    /// No requirement, and deliberately: a gallery with no cover property is a grid of titled
    /// cards, which is readable and useful and is what most galleries are on the day they are made.
    /// A requirement is a property whose absence leaves nothing on screen - a board with no
    /// grouping has no columns at all - and a cover is not one.
    /// </remarks>
    Gallery = 3,

    /// <summary>Children as horizontal bars across a time axis, spanning a start and an end.</summary>
    /// <remarks>
    /// <para>
    /// One requirement, not two, and it is the calendar's verbatim. A start date is what puts a bar
    /// on the axis at all - no start, no position - so its absence leaves nothing on screen, which
    /// is the test this codebase applies. An end date is a different thing: an item with a start and
    /// no end is a milestone, which is a real and drawable shape, and a timeline of milestones is a
    /// perfectly good timeline.
    /// </para>
    /// <para>
    /// <b>An end before its start is not refused here.</b> The two are independent property writes
    /// and cannot both be valid at every instant, so refusing would make the fix depend on which one
    /// somebody happens to correct first - the same argument <c>SetContainerViewsHandler.Refuse</c>
    /// makes about a view naming a property the schema does not declare yet. The view reports the
    /// pair; the server does not police it.
    /// </para>
    /// </remarks>
    Timeline = 4,

    /// <summary>Children as an editable grid, one row per child and one column per property.</summary>
    /// <remarks>
    /// The <em>view</em> axis only: rows are children and cells are property values, so an edit
    /// here is a property write visible in every other view. The spreadsheet <em>body</em>
    /// (<c>item.type == "spreadsheet"</c>) is the other axis - free cells and formulas, owned by
    /// the item itself. The two axes share a vocabulary and always will: the stored words differ
    /// (<c>"sheet"</c> here, <c>"spreadsheet"</c> there) only so the wire values cannot collide,
    /// and a grep for either word still lands on both features' surroundings - mind the axis when
    /// reading a hit.
    /// </remarks>
    Sheet = 5,

    /// <summary>A fillable form over the schema; each submission creates a child.</summary>
    /// <remarks>
    /// The intake shape - a daily tracker, an inventory log: the view renders the container's
    /// effective schema as fields, and a submit is an ordinary item create carrying the values.
    /// Nothing new is stored or read on this axis; the kind exists so a container can *offer*
    /// entry as a view, switchable beside the list the entries land in. ADR-0040 records why a
    /// kind that writes children rather than drawing them still belongs on this axis.
    /// </remarks>
    Form = 6,

    /// <summary>A saved cross-container query: the view's filters, run server-side.</summary>
    /// <remarks>
    /// The smart-list kind (goal 3.4). Unlike every other kind it does not draw the item's own
    /// children - its results come from <c>GET /items/{id}/query</c>, which compiles the stored
    /// <see cref="ViewDefinition.Filters"/> into SQL filtered by the reader's own reach. The
    /// client never sends rules; the stored view is the whole query. ADR-0039 records the design.
    /// </remarks>
    Query = 7,

    /// <summary>A multi-page, conditional form whose answers create a child item.</summary>
    InteractiveForm = 8,

    /// <summary>Children summarised into buckets: counted, or totalled by a numeric property.</summary>
    /// <remarks>
    /// <para>
    /// Goal 2.3, and a way of looking at children like every other kind on this axis - "how much of
    /// this is Done" is the same question a board answers by eye, drawn so it can be read at a
    /// glance instead of counted.
    /// </para>
    /// <para>
    /// <b>It groups by the property a board would group by, under the board's own field.</b> The
    /// same requirement and the same reason: grouping by free text would produce a bar per distinct
    /// value, which is a chart nobody can read. Sharing <see cref="ViewDefinition.GroupBy"/> is what
    /// makes switching a view between board and chart lossless, exactly as the calendar and the
    /// timeline share their date property.
    /// </para>
    /// <para>
    /// <b>Its buckets come from the server, not from the loaded page.</b> Like <see cref="Query"/>
    /// and unlike every other kind, it does not draw what the client already holds: a chart over a
    /// container whose children are only partly loaded would be a picture of the first page
    /// presented as a picture of the whole. <c>GET /items/{id}/chart</c> is where the buckets come
    /// from, and ADR-0044 records why the aggregate is computed where the rows are.
    /// </para>
    /// </remarks>
    Chart = 9,
}

/// <summary>
/// What a kind needs from the schema before it can draw anything.
/// </summary>
/// <param name="Read">Which field on the view names the property this kind depends on.</param>
/// <param name="Accepts">Which property types will serve.</param>
/// <param name="Missing">
/// How to finish the sentence "'&lt;view name&gt;': ..." when the field is not set.
/// </param>
/// <remarks>
/// A list has no requirement: with no columns configured it falls back to the effective schema, and
/// with no schema at all it still has titles to show. That is why this is nullable on the
/// descriptor rather than every kind carrying a vacuous one.
/// </remarks>
public sealed record ViewRequirement(
    Func<ViewDefinition, string?> Read,
    Func<Nix.Domain.Properties.PropertyType, bool> Accepts,
    string Missing);

/// <summary>
/// Everything this build knows about one view kind, in one place.
/// </summary>
/// <param name="Kind">The kind.</param>
/// <param name="Text">The name it is stored and published under.</param>
/// <param name="Requirement">What it needs from the schema, or null when it needs nothing.</param>
public sealed record ViewKindDescriptor(ViewKind Kind, string Text, ViewRequirement? Requirement);

/// <summary>
/// The kinds this build can draw, and what each one needs.
/// </summary>
/// <remarks>
/// <para>
/// <b>One entry per kind, and adding a kind is one entry.</b> This knowledge used to be spread
/// across four switch statements - parse, write, "can this render", and "is this storable" - which
/// meant adding a kind was four edits in two projects and forgetting one of them compiled fine.
/// The table is the single declaration; the four call sites read it.
/// </para>
/// <para>
/// Stored as text, never as the ordinal, so renumbering the enum cannot reinterpret stored views.
/// Parsing fails closed: a kind this build does not recognise is dropped, so an older instance
/// offers fewer views rather than rendering one it does not understand.
/// </para>
/// <para>
/// A kind added to <see cref="ViewKind"/> but not to this table has no text to be stored under, so
/// <see cref="ToText"/> throws rather than inventing one. <c>Every_kind_has_a_descriptor</c> in the
/// test suite is what turns that runtime bug into a build failure.
/// </para>
/// </remarks>
public static class ViewKinds
{
    /// <summary>Every kind this build knows.</summary>
    public static readonly ImmutableArray<ViewKindDescriptor> All =
    [
        new ViewKindDescriptor(ViewKind.List, "list", Requirement: null),

        new ViewKindDescriptor(
            ViewKind.Board,
            "board",
            new ViewRequirement(
                static view => view.GroupBy,
                static type => Nix.Domain.Properties.PropertyTypes.CanGroupBy(type),
                "a board needs a property to group by")),

        new ViewKindDescriptor(
            ViewKind.Calendar,
            "calendar",
            new ViewRequirement(
                static view => view.DateProperty,
                static type => Nix.Domain.Properties.PropertyTypes.CanPlaceOnCalendar(type),
                "a calendar needs a date property")),

        // Like a list, and for the same reason: a gallery with no cover property still has titled
        // cards to draw. The cover is an enrichment, not the thing that makes the view exist.
        new ViewKindDescriptor(ViewKind.Gallery, "gallery", Requirement: null),

        // The calendar's requirement, reused field for field: a timeline places a bar by the same
        // date property a calendar places a card by, which is what makes switching a view between
        // the two lossless. Only the sentence differs, because the two views want different things
        // said to somebody who has not configured one yet.
        new ViewKindDescriptor(
            ViewKind.Timeline,
            "timeline",
            new ViewRequirement(
                static view => view.DateProperty,
                static type => Nix.Domain.Properties.PropertyTypes.CanPlaceOnCalendar(type),
                "a timeline needs a date to start from")),

        // Like a list, and by the list's own argument: with no columns configured the grid falls
        // back to the effective schema, and with no schema at all it still has titles to show.
        new ViewKindDescriptor(ViewKind.Sheet, "sheet", Requirement: null),

        // Requirement-free by the same fallback: with no columns configured the form offers the
        // effective schema's fields, and with no schema at all it still takes a title.
        new ViewKindDescriptor(ViewKind.Form, "form", Requirement: null),

        // Requirement-free because the requirement mechanism reads one string field and this
        // kind's configuration is the Filters array - policed in SetContainerViewsHandler.Refuse
        // instead. An empty filter set is valid and means "everything readable, newest first".
        new ViewKindDescriptor(ViewKind.Query, "query", Requirement: null),

        new ViewKindDescriptor(ViewKind.InteractiveForm, "interactive_form", Requirement: null),

        // The board's requirement, reused field for field, which is what makes switching a view
        // between the two lossless. Only the sentence differs, because the two kinds want
        // different things said to somebody who has not configured one yet.
        new ViewKindDescriptor(
            ViewKind.Chart,
            "chart",
            new ViewRequirement(
                static view => view.GroupBy,
                static type => Nix.Domain.Properties.PropertyTypes.CanGroupBy(type),
                "a chart needs a property to group by")),
    ];

    /// <summary>Reads a stored kind.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="kind">The kind, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a kind this build knows.</returns>
    public static bool TryParse(string? text, out ViewKind kind)
    {
        // A scan rather than a dictionary: the table is a handful of entries, and an ordinal
        // comparison over three strings beats hashing one.
        foreach (var descriptor in All)
        {
            if (string.Equals(descriptor.Text, text, StringComparison.Ordinal))
            {
                kind = descriptor.Kind;
                return true;
            }
        }

        kind = default;
        return false;
    }

    /// <summary>Writes a kind for storage.</summary>
    /// <param name="kind">The kind.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The kind is not one this build defines.</exception>
    public static string ToText(ViewKind kind) =>
        Find(kind)?.Text
        ?? throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown view kind.");

    /// <summary>Finds what this build knows about a kind.</summary>
    /// <param name="kind">The kind.</param>
    /// <returns>The descriptor, or <see langword="null"/> when the table has no entry for it.</returns>
    public static ViewKindDescriptor? Find(ViewKind kind)
    {
        foreach (var descriptor in All)
        {
            if (descriptor.Kind == kind)
            {
                return descriptor;
            }
        }

        return null;
    }
}

/// <summary>
/// The sizes a gallery may draw its cards at.
/// </summary>
/// <remarks>
/// <para>
/// A closed set, unlike <c>Mode</c>, whose unrecognised values each kind quietly defaults: the
/// grain vocabularies overlap across kinds on purpose, so the field has to stay open for a view to
/// switch kinds losslessly. A card size is one kind's own and shared with nothing, so there is
/// nothing an unknown value could be preserving - <c>SetContainerViewsHandler.Refuse</c> refuses it
/// outright, which tells the person typing it now rather than the person reading a silently
/// medium-sized gallery later.
/// </para>
/// <para>
/// Stored as text rather than as an enum for the same reason <see cref="ViewKinds"/> stores text:
/// the words are the contract, and renumbering nothing can reinterpret them.
/// </para>
/// </remarks>
/// <summary>What a chart's bars measure.</summary>
/// <remarks>
/// <b>Two, and both always have an answer.</b> A count needs nothing configured, and a total needs
/// a numeric property. Anything else - a median, a distinct count - is a fold this build does not
/// compute, and offering one it could not draw would be a chart that renders empty for a reason
/// nobody can see. Stored as text, like every other vocabulary here.
/// </remarks>
public static class ChartMeasures
{
    /// <summary>How many children fall in each bucket. The default, and what absent has always meant.</summary>
    public const string Count = "count";

    /// <summary>The total of a numeric property across the children in each bucket.</summary>
    public const string Sum = "sum";

    /// <summary>Whether a stored or requested value names a measure this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of the two.</returns>
    public static bool IsValid(string value) =>
        string.Equals(value, Count, StringComparison.Ordinal)
        || string.Equals(value, Sum, StringComparison.Ordinal);
}

public static class GalleryCardSizes
{
    /// <summary>Denser columns and a squarer cover.</summary>
    public const string Small = "small";

    /// <summary>The default, and what absent has always meant.</summary>
    public const string Medium = "medium";

    /// <summary>Fewer columns and a more generous cover.</summary>
    public const string Large = "large";

    /// <summary>Whether a stored or requested value names a size this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of the three sizes.</returns>
    public static bool IsValid(string value) =>
        string.Equals(value, Small, StringComparison.Ordinal)
        || string.Equals(value, Medium, StringComparison.Ordinal)
        || string.Equals(value, Large, StringComparison.Ordinal);
}

/// <summary>
/// One named way of looking at a container.
/// </summary>
/// <param name="Id">
/// Stable across renames, because the active view is named in the URL and a shared link must not
/// break when somebody renames the view it points at.
/// </param>
/// <param name="Name">What a person sees in the switcher.</param>
/// <param name="Kind">Which renderer this view uses.</param>
/// <param name="Columns">
/// For a list: the property keys to show, in order. Empty means the effective schema decides,
/// which is what a view created without configuration should do.
/// </param>
/// <param name="GroupBy">For a board: the single-select property whose values become columns.</param>
/// <param name="GroupOrder">
/// For a board: which of that property's values to show, in which order. Empty means every value
/// the schema declares.
/// </param>
/// <param name="DateProperty">
/// For a calendar: the date property that places an item. For a timeline: the date a bar starts on.
/// </param>
/// <param name="SortBy">The property key to order by, or <see langword="null"/> for sibling order.</param>
/// <param name="SortDescending">Which way to order.</param>
/// <param name="Mode">
/// The per-kind grain. For a calendar: <c>month</c>, <c>week</c> or <c>day</c>. For a timeline:
/// <c>week</c>, <c>month</c> or <c>quarter</c>. Anything else, including absent, means that kind's
/// own default. The two vocabularies overlapping is deliberate: it is what lets a view switched
/// between the two kinds keep the grain it had rather than being reset to one nobody chose.
/// </param>
/// <param name="CoverProperty">
/// For a gallery: the image property whose value each card shows as its cover, or
/// <see langword="null"/> for a grid of titled cards.
/// </param>
/// <param name="EndDateProperty">
/// For a timeline: the date a bar ends on, or <see langword="null"/> for a timeline of milestones.
/// </param>
/// <param name="CardSize">
/// For a gallery: how large each card is drawn - <c>small</c>, <c>medium</c> or <c>large</c>, and
/// <see langword="null"/> means <c>medium</c>, which is what every gallery stored before this field
/// existed has always looked like.
/// </param>
/// <param name="Filters">
/// For a query: the conditions the server compiles and runs, AND-combined. Default and empty both
/// mean no conditions; on every other kind the field is stored and ignored.
/// </param>
/// <remarks>
/// <para>
/// <b>One record for every kind, rather than a hierarchy.</b> The per-kind fields are nullable
/// and a view ignores the ones that are not its own. A discriminated hierarchy would be tidier in
/// the type system and worse everywhere else: this shape is serialised to a jsonb column and to an
/// OpenAPI schema, and both would need the union spelled out by hand, in two more places that can
/// disagree with this one.
/// </para>
/// <para>
/// <b><see cref="GroupOrder"/> is the view's, not the schema's.</b> The specification is explicit
/// that board columns are freely definable and not tied to a property's allowed values - a board
/// may show three of six statuses and order them however it likes.
/// </para>
/// <para>
/// <b>There is no placement or layout here, deliberately.</b> A card's position on a board is its
/// property value and its sibling order, never a coordinate stored against the view. That is what
/// makes dragging a card an edit to the item - visible in every other view and to everybody else -
/// rather than a change to how one person happens to be looking at it.
/// </para>
/// </remarks>
public sealed record FormCondition(string FieldBlockId, string Operator, string? Value);

public sealed record FormBlock(
    string Id,
    string Kind,
    string? PropertyKey,
    string Text,
    string? Help,
    bool Required,
    string? IdentityRole,
    ImmutableArray<FormCondition> VisibleWhen);

public sealed record FormPage(
    string Id,
    string Title,
    string? Description,
    ImmutableArray<FormCondition> VisibleWhen,
    ImmutableArray<FormBlock> Blocks);

public sealed record InteractiveFormDefinition(
    ImmutableArray<FormPage> Pages,
    string TitleMode,
    string? TitleFieldBlockId,
    string ConfirmationTitle,
    string ConfirmationMessage);

public sealed record ViewDefinition(
    string Id,
    string Name,
    ViewKind Kind,
    ImmutableArray<string> Columns,
    string? GroupBy,
    ImmutableArray<string> GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending,

    // Last and defaulted, so every existing construction keeps working and absent keeps meaning
    // "month" - which is what every view stored before this field existed.
    string? Mode = null,

    // Same rule, and it is the record's own: every construction here is positional, so a per-kind
    // field added anywhere but the end would silently re-bind arguments at dozens of call sites.
    // Absent means a gallery of titled cards, which is what every view stored before this existed.
    string? CoverProperty = null,

    // Same rule again. **Not paired with DateProperty into a range, and DateProperty is not renamed
    // to StartDateProperty**: that name is what a stored calendar already uses, so renaming it would
    // break every calendar in every workspace, and keeping it is what makes switching a view between
    // calendar and timeline lossless in both directions.
    //
    // Nullable because it is genuinely optional: a start with no end is a milestone, which the
    // timeline draws as a point rather than as a bar. Nothing here refuses an end that falls before
    // its start; see ViewKind.Timeline for why that is the view's report to make and not the
    // server's.
    string? EndDateProperty = null,

    // Same rule once more: last and defaulted, so no positional construction re-binds. Null means
    // medium - the size every gallery drew at before the field existed - and the value set is
    // closed and policed on write; see GalleryCardSizes for why this one is refused where Mode's
    // strays are defaulted.
    string? CardSize = null,

    // Last and defaulted like every field added since the record was first cut. For a query view:
    // the conditions the server compiles and runs, AND-combined, each policed on write against
    // QueryOperators' closed grammar. Default (unset) and empty both mean "no conditions" - for a
    // query view that is "everything readable, newest first", and for every other kind the field
    // is stored and ignored (ADR-0020: cheap to ignore, expensive to police). ADR-0039 records
    // why this is a structured field rather than a packed string.
    ImmutableArray<FilterRule> Filters = default,
    string? CompanionViewId = null,
    string? CompanionPlacement = null,
    InteractiveFormDefinition? InteractiveForm = null,

    // Last and defaulted like every field added since the record was cut. For a chart: what each
    // bar measures - `count`, which needs nothing else, or `sum`, which totals MeasureProperty
    // across the children in each bucket. Null and an unrecognised value both mean `count`, which
    // is what a chart with nothing configured draws and the only measure that always has an answer.
    string? Measure = null,
    string? MeasureProperty = null)
{
    /// <summary>
    /// Whether this view can render given the schema in force.
    /// </summary>
    /// <param name="schema">The effective schema at the container.</param>
    /// <returns><see langword="true"/> when the view's required property exists and fits.</returns>
    /// <remarks>
    /// A board grouping by a property that has since been deleted, or retyped to something that
    /// cannot be grouped, has no columns to draw. Asking here lets the interface say so plainly
    /// rather than rendering an empty board that looks like an item with nothing in it.
    /// </remarks>
    public bool CanRender(Nix.Domain.Properties.PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        // A kind with no requirement always renders, and a kind this build has no descriptor for
        // cannot be drawn at all - which is the safer answer than "yes" for something unknown.
        if (ViewKinds.Find(Kind) is not { } descriptor)
        {
            return false;
        }

        if (descriptor.Requirement is not { } requirement)
        {
            return true;
        }

        return requirement.Read(this) is { } key
            && schema.Find(key) is { } property
            && requirement.Accepts(property.Type);
    }
}
