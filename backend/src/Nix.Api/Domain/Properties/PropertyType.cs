namespace Nix.Domain.Properties;

/// <summary>
/// The kinds of value a property may hold.
/// </summary>
/// <remarks>
/// <para>
/// <b>A closed set, chosen here because no document specifies one.</b> The specification assumes a
/// select type (boards group by one) and a date type (calendars place by one) and never enumerates
/// the rest. Every member earns its place by being what some view needs: a type that could not be
/// sorted, grouped, placed on a calendar or shown as a cover would be a type with no view to
/// render it.
/// </para>
/// <para>
/// <b>Stored as text, never as this ordinal.</b> See <see cref="PropertyTypes"/>. A migration that
/// renumbered the enum must not silently reinterpret every stored schema.
/// </para>
/// <para>
/// Adding a type is deliberately a small change: a member here, a case in
/// <see cref="PropertyTypes"/>, and a case in the validator. Nothing else branches on this - the
/// views ask what a property can do, not what it is - so a new type does not ripple.
/// </para>
/// </remarks>
public enum PropertyType
{
    /// <summary>A single line of text.</summary>
    Text = 0,

    /// <summary>A number, stored as a JSON number.</summary>
    Number = 1,

    /// <summary>One value from a declared list. What a board groups by.</summary>
    Select = 2,

    /// <summary>Any number of values from a declared list.</summary>
    MultiSelect = 3,

    /// <summary>A date, without a time. What a calendar places by.</summary>
    Date = 4,

    /// <summary>True or false.</summary>
    Checkbox = 5,

    /// <summary>An absolute URL.</summary>
    Url = 6,

    /// <summary>
    /// A moment, keeping the local time it was written as and the zone it was written in. What a
    /// calendar places by when the calendar has hours in it.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="Date"/> rather than replacing it. A date means "the 3rd" and must
    /// not shift for a reader in another zone; a timestamp means a moment, and must. Both belong on
    /// a calendar, and conflating them would make one of them wrong.
    /// </remarks>
    Timestamp = 7,

    /// <summary>A picture, as an http or https address. What a gallery card shows as its cover.</summary>
    /// <remarks>
    /// <para>
    /// <b>Its own type rather than a <see cref="Url"/> with a convention on top.</b> A link and a
    /// picture are read differently by everything that meets them: a link is text somebody clicks,
    /// and this is fetched and rendered by the browser without anybody deciding to. The schema
    /// saying which one it is, is what lets a gallery offer covers from the properties that are
    /// covers rather than from every link in the workspace.
    /// </para>
    /// <para>
    /// <b>It holds an address today and becomes a file reference at MVP-6</b>, when there is a
    /// media model to reference. There is no file or media model in the backend at all yet, so
    /// storing a reference now would be storing an identifier for a table nothing writes to.
    /// Changing the value's shape later is a migration of the values, not of this member.
    /// </para>
    /// </remarks>
    Image = 8,
}

/// <summary>
/// Translates between <see cref="PropertyType"/> and the text stored in a schema.
/// </summary>
/// <remarks>
/// <b>Parsing fails closed.</b> A type this build does not recognise is not a type: the property is
/// dropped from the effective schema rather than guessed at, so an older instance still serving
/// traffic stops validating and stops displaying a property it cannot interpret, instead of
/// accepting values against a rule it invented. That is a loss of function, which is recoverable;
/// the other direction is not.
/// </remarks>
public static class PropertyTypes
{
    /// <summary>Reads a stored type name.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="type">The type, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a type this build knows.</returns>
    public static bool TryParse(string? text, out PropertyType type)
    {
        switch (text)
        {
            case "text":
                type = PropertyType.Text;
                return true;
            case "number":
                type = PropertyType.Number;
                return true;
            case "select":
                type = PropertyType.Select;
                return true;
            case "multi_select":
                type = PropertyType.MultiSelect;
                return true;
            case "date":
                type = PropertyType.Date;
                return true;
            case "checkbox":
                type = PropertyType.Checkbox;
                return true;
            case "url":
                type = PropertyType.Url;
                return true;
            case "timestamp":
                type = PropertyType.Timestamp;
                return true;
            case "image":
                type = PropertyType.Image;
                return true;
            default:
                type = default;
                return false;
        }
    }

    /// <summary>Writes a type for storage.</summary>
    /// <param name="type">The type.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The type is not one this build defines.</exception>
    public static string ToText(PropertyType type) => type switch
    {
        PropertyType.Text => "text",
        PropertyType.Number => "number",
        PropertyType.Select => "select",
        PropertyType.MultiSelect => "multi_select",
        PropertyType.Date => "date",
        PropertyType.Checkbox => "checkbox",
        PropertyType.Url => "url",
        PropertyType.Timestamp => "timestamp",
        PropertyType.Image => "image",
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown property type."),
    };

    /// <summary>Whether a type draws its values from a declared list.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for the select types.</returns>
    /// <remarks>
    /// Asked rather than pattern-matched at the call sites, so adding a third list-valued type is
    /// one edit here instead of a search for every place that compared against two names.
    /// </remarks>
    public static bool HasOptions(this PropertyType type) =>
        type is PropertyType.Select or PropertyType.MultiSelect;

    /// <summary>Whether a board may group by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> when grouping produces a bounded set of columns.</returns>
    /// <remarks>
    /// Single-select only. Grouping by free text would produce a column per distinct value, which
    /// is a board nobody can read; grouping by a multi-select would put one card in several
    /// columns, and then dragging it between them has no defined meaning.
    /// </remarks>
    public static bool CanGroupBy(this PropertyType type) => type is PropertyType.Select;

    /// <summary>Whether a calendar may place items by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for dates.</returns>
    public static bool CanPlaceOnCalendar(this PropertyType type) =>
        type is PropertyType.Date or PropertyType.Timestamp;
}
