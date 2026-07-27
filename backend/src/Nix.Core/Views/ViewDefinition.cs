using System.Collections.Immutable;

namespace Nix.Core.Views;

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
    Func<Nix.Core.Properties.PropertyType, bool> Accepts,
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
                static type => Nix.Core.Properties.PropertyTypes.CanGroupBy(type),
                "a board needs a property to group by")),

        new ViewKindDescriptor(
            ViewKind.Calendar,
            "calendar",
            new ViewRequirement(
                static view => view.DateProperty,
                static type => Nix.Core.Properties.PropertyTypes.CanPlaceOnCalendar(type),
                "a calendar needs a date property")),
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
/// <param name="DateProperty">For a calendar: the date property that places an item.</param>

/// <param name="SortBy">The property key to order by, or <see langword="null"/> for sibling order.</param>
/// <param name="SortDescending">Which way to order.</param>
/// <param name="Mode">
/// For a calendar: <c>month</c>, <c>week</c> or <c>day</c>. Anything else, including absent, means
/// a month.
/// </param>
/// <remarks>
/// <para>
/// <b>One record for all three kinds, rather than a hierarchy.</b> The per-kind fields are nullable
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
    string? Mode = null)
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
    public bool CanRender(Nix.Core.Properties.PropertySchema schema)
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
