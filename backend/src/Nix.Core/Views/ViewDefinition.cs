using System.Collections.Immutable;

namespace Nix.Core.Views;

/// <summary>
/// How a container may be looked at.
/// </summary>
/// <remarks>
/// A view is a way of rendering a container's children, not a place in the application. That is
/// why it is stored on the container rather than being a route: "board" is something a folder can
/// be shown as, and the same folder can be shown as a list a moment later without going anywhere.
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
/// Translates between <see cref="ViewKind"/> and the text stored in a view definition.
/// </summary>
/// <remarks>
/// Stored as text, never as the ordinal, so renumbering the enum cannot reinterpret stored views.
/// Parsing fails closed: a kind this build does not recognise is dropped, so an older instance
/// offers fewer views rather than rendering one it does not understand.
/// </remarks>
public static class ViewKinds
{
    /// <summary>Reads a stored kind.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="kind">The kind, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a kind this build knows.</returns>
    public static bool TryParse(string? text, out ViewKind kind)
    {
        switch (text)
        {
            case "list":
                kind = ViewKind.List;
                return true;
            case "board":
                kind = ViewKind.Board;
                return true;
            case "calendar":
                kind = ViewKind.Calendar;
                return true;
            default:
                kind = default;
                return false;
        }
    }

    /// <summary>Writes a kind for storage.</summary>
    /// <param name="kind">The kind.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The kind is not one this build defines.</exception>
    public static string ToText(ViewKind kind) => kind switch
    {
        ViewKind.List => "list",
        ViewKind.Board => "board",
        ViewKind.Calendar => "calendar",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown view kind."),
    };
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
    bool SortDescending)
{
    /// <summary>
    /// Whether this view can render given the schema in force.
    /// </summary>
    /// <param name="schema">The effective schema at the container.</param>
    /// <returns><see langword="true"/> when the view's required property exists and fits.</returns>
    /// <remarks>
    /// A board grouping by a property that has since been deleted, or retyped to something that
    /// cannot be grouped, has no columns to draw. Asking here lets the interface say so plainly
    /// rather than rendering an empty board that looks like an empty folder.
    /// </remarks>
    public bool CanRender(Nix.Core.Properties.PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        return Kind switch
        {
            ViewKind.Board => GroupBy is { } key
                && schema.Find(key) is { } grouping
                && Nix.Core.Properties.PropertyTypes.CanGroupBy(grouping.Type),

            ViewKind.Calendar => DateProperty is { } date
                && schema.Find(date) is { } placement
                && Nix.Core.Properties.PropertyTypes.CanPlaceOnCalendar(placement.Type),

            // A list always renders: with no columns configured it falls back to the effective
            // schema, and with no schema at all it still has titles to show.
            _ => true,
        };
    }
}
