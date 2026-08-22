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

    /// <summary>
    /// The date something is owed. Value-shaped exactly like <see cref="Date"/>; the type is the
    /// meaning.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The five task types (this one through <see cref="Estimate"/>) carry their meaning in the
    /// type, deliberately, because that is what goal 3.1 replaces:</b> before them, "the due date"
    /// was a key-name convention (<c>due</c>) that smart lists, seeds and tests each restated. A
    /// schema that declares a property <em>is</em> the due date lets every view bind to the
    /// meaning and lets a workspace call the key whatever it likes. At most one property of each
    /// task type may be declared per schema - "the" due date cannot be two properties - and
    /// <see cref="Domain.Properties.PropertySchemaRules"/> enforces it.
    /// </para>
    /// <para>
    /// This is also what recurrence (3.2) anchors to: a repeating rule expands from the item's
    /// due date, so an item with a rule and no due-date property has nothing to repeat.
    /// </para>
    /// </remarks>
    DueDate = 9,

    /// <summary>
    /// The date work begins. Value-shaped exactly like <see cref="Date"/>; what a timeline draws
    /// as a bar's left edge, paired with <see cref="DueDate"/> as its right.
    /// </summary>
    StartDate = 10,

    /// <summary>
    /// Whether the item is done. Value-shaped exactly like <see cref="Checkbox"/>; the type says
    /// this particular flag is the one that means finished, which is what an Overdue list must
    /// exclude by and a progress rollup must count.
    /// </summary>
    Completion = 11,

    /// <summary>
    /// How urgent, as an integer from 1 (most urgent) to 4 (least). A closed numeric scale rather
    /// than a select, so ordering is intrinsic and no workspace invents "High"/"Highest"/"Urgent"
    /// option sets that cannot be compared.
    /// </summary>
    Priority = 12,

    /// <summary>
    /// How much work, as a non-negative number. The unit is the team's convention (hours,
    /// typically) - the type promises only that estimates are numbers a rollup can sum.
    /// </summary>
    Estimate = 13,

    /// <summary>
    /// Who the item is for: the assigned principal's identifier, as a canonical lowercase UUID
    /// string identifying a <see cref="Domain.Identity.PrincipalId"/>. What an assignee filter and
    /// a workload read bind to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>An identifier, never a display name.</b> A name is not an identity: it changes when
    /// somebody is renamed, and two people can share one, so a filter or a workload read compiled
    /// against a name would silently drift onto the wrong person or merge two people into one
    /// bucket. The identifier is stable and unique for exactly as long as the principal exists,
    /// which is the property a binding actually needs.
    /// </para>
    /// <para>
    /// <b>Not groupable and not calendar-placeable.</b> Grouping a board by a raw identifier would
    /// title every column with a UUID nobody can read - the same reason <see cref="Select"/> and
    /// not <see cref="Text"/> is what a board groups by. It carries no options either: the set of
    /// principals somebody could assign to is a workspace membership fact, not a per-schema
    /// declared list, and offering it belongs to the surface that reads membership.
    /// </para>
    /// <para>
    /// <b>Task-semantic</b>, taking the reserved key <c>assignee</c> under ADR-0042's rule: a
    /// cross-workspace smart list for "assigned to me" compiles against a key, the same argument
    /// that reserves <see cref="DueDate"/>'s.
    /// </para>
    /// </remarks>
    Assignee = 14,

    /// <summary>
    /// A value computed from the item's other properties by an expression, never written.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The expression lives on the declaration and the value lives nowhere.</b> A formula
    /// property is evaluated wherever it is read, from the values the item carries at that moment,
    /// so it cannot go stale and no write has to recompute anything. That is what goal 2.1's
    /// "evaluated on read" means, and it is why this type is the one type whose values
    /// <see cref="PropertyValidator"/> refuses outright: a stored value for a computed property
    /// would be a second answer able to disagree with the first.
    /// </para>
    /// <para>
    /// <b>Core stores and checks the expression; it does not evaluate one.</b> The formula engine
    /// that ships is <c>@nix/sheet</c>, shared by the editor and the collaboration service so a
    /// formula's value can never differ between them, and a C# evaluator here would be exactly the
    /// second engine goal 2.1 exists to avoid. What Core does own is the part that must not depend
    /// on a client behaving: the references an expression makes are extracted here and the schema is
    /// refused when they form a cycle among the properties it declares - see
    /// <see cref="Domain.Properties.FormulaReferences"/>. ADR-0044 records the split and why it is
    /// drawn by what a value is rather than by where it is convenient to compute.
    /// </para>
    /// </remarks>
    Formula = 15,

    /// <summary>
    /// A value aggregated across the item's children, never written.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>How a container answers "how much of this is done".</b> The declaration names a property
    /// of the children and one of <see cref="RollupAggregate"/>'s reductions; the value is folded
    /// when the item is read and stored nowhere, so it cannot disagree with the children it is
    /// folded from.
    /// </para>
    /// <para>
    /// <b>Computed in SQL, not by the formula engine, and that is the split ADR-0044 draws.</b> A
    /// rollup is an aggregate rather than an expression, so it belongs where the rows are: the
    /// client would otherwise have to fetch every child of every item it draws one for, which the
    /// stress row puts at 3,000+ per container and which is not expressible at all for a list of a
    /// hundred items each showing one. A <see cref="Formula"/> may then read a rollup's value as an
    /// ordinary field, which is what lets "percent complete" be a formula over a rollup rather than
    /// a third mechanism.
    /// </para>
    /// </remarks>
    Rollup = 16,
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
            case "due_date":
                type = PropertyType.DueDate;
                return true;
            case "start_date":
                type = PropertyType.StartDate;
                return true;
            case "completion":
                type = PropertyType.Completion;
                return true;
            case "priority":
                type = PropertyType.Priority;
                return true;
            case "estimate":
                type = PropertyType.Estimate;
                return true;
            case "assignee":
                type = PropertyType.Assignee;
                return true;
            case "formula":
                type = PropertyType.Formula;
                return true;
            case "rollup":
                type = PropertyType.Rollup;
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
        PropertyType.DueDate => "due_date",
        PropertyType.StartDate => "start_date",
        PropertyType.Completion => "completion",
        PropertyType.Priority => "priority",
        PropertyType.Estimate => "estimate",
        PropertyType.Assignee => "assignee",
        PropertyType.Formula => "formula",
        PropertyType.Rollup => "rollup",
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown property type."),
    };

    /// <summary>Whether a type's values are computed on read rather than written.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> when nothing may write a value of this type.</returns>
    /// <remarks>
    /// Asked rather than compared against a member, because the set has already grown once: the
    /// rollup joined the formula here, and every rule that holds for a computed property - no
    /// stored value, never required, no options, refused on write - holds for both. A call site
    /// that pattern-matched <see cref="PropertyType.Formula"/> by name would have had to be found
    /// again for the second one.
    /// </remarks>
    public static bool IsComputed(this PropertyType type) =>
        type is PropertyType.Formula or PropertyType.Rollup;

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
    /// <returns><see langword="true"/> for the date-shaped types.</returns>
    public static bool CanPlaceOnCalendar(this PropertyType type) =>
        type is PropertyType.Date or PropertyType.Timestamp
            or PropertyType.DueDate or PropertyType.StartDate;

    /// <summary>
    /// Whether a type names a task-semantic role, of which a schema may declare at most one.
    /// </summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for a type that names a task-semantic role.</returns>
    /// <remarks>
    /// "The due date" is singular by meaning: two properties both claiming to be it would leave
    /// every view that binds to the meaning choosing arbitrarily. Ordinary types carry no such
    /// claim, so a schema may declare as many dates or checkboxes as it likes.
    /// </remarks>
    public static bool IsTaskSemantic(this PropertyType type) =>
        type is PropertyType.DueDate or PropertyType.StartDate or PropertyType.Completion
            or PropertyType.Priority or PropertyType.Estimate or PropertyType.Assignee;
}
