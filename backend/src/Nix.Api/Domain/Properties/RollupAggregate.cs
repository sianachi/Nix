namespace Nix.Domain.Properties;

/// <summary>
/// How a rollup reduces a property across an item's children to one value.
/// </summary>
/// <remarks>
/// <para>
/// <b>A closed set, and goal 2.2 names it.</b> Count, sum, min, max, average, any and all - the
/// seven a container needs to answer "how much of this is done". A rollup is not an expression and
/// deliberately never becomes one: an expression over children would be a second formula engine
/// with a row set behind it, and the one that ships already covers the case that matters by reading
/// a rollup's value as an ordinary field.
/// </para>
/// <para>
/// Stored as text, never as an ordinal, for the reason every other vocabulary here is: renumbering
/// must not reinterpret what is already stored.
/// </para>
/// </remarks>
public enum RollupAggregate
{
    /// <summary>
    /// How many children carry a value for the property, or how many children there are when the
    /// rollup names no property.
    /// </summary>
    /// <remarks>
    /// The one aggregate whose source property is optional, because "how many things are in here"
    /// is a question about the container rather than about any property of its contents.
    /// </remarks>
    Count = 0,

    /// <summary>The total of the numeric values.</summary>
    Sum = 1,

    /// <summary>The smallest numeric value.</summary>
    Min = 2,

    /// <summary>The largest numeric value.</summary>
    Max = 3,

    /// <summary>The mean of the numeric values, over the children that have one.</summary>
    /// <remarks>
    /// Over the children that <em>have</em> a value, not over every child: an average that counted
    /// the blanks as zero would fall as somebody added rows they had not filled in yet, which reads
    /// as work getting worse when nothing changed.
    /// </remarks>
    Average = 4,

    /// <summary>Whether any child's value is true.</summary>
    Any = 5,

    /// <summary>
    /// Whether every child's value is true. True of no children at all, as an empty conjunction is.
    /// </summary>
    All = 6,
}

/// <summary>Translates between <see cref="RollupAggregate"/> and the text stored in a schema.</summary>
/// <remarks>
/// Parsing fails closed, exactly as <see cref="PropertyTypes"/> does: an aggregate this build does
/// not recognise is not an aggregate, and the property is dropped from the effective schema rather
/// than reduced by a rule this build invented.
/// </remarks>
public static class RollupAggregates
{
    /// <summary>Reads a stored aggregate name.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="aggregate">The aggregate, when recognised.</param>
    /// <returns><see langword="true"/> when the text names one this build knows.</returns>
    public static bool TryParse(string? text, out RollupAggregate aggregate)
    {
        switch (text)
        {
            case "count":
                aggregate = RollupAggregate.Count;
                return true;
            case "sum":
                aggregate = RollupAggregate.Sum;
                return true;
            case "min":
                aggregate = RollupAggregate.Min;
                return true;
            case "max":
                aggregate = RollupAggregate.Max;
                return true;
            case "average":
                aggregate = RollupAggregate.Average;
                return true;
            case "any":
                aggregate = RollupAggregate.Any;
                return true;
            case "all":
                aggregate = RollupAggregate.All;
                return true;
            default:
                aggregate = default;
                return false;
        }
    }

    /// <summary>Writes an aggregate for storage.</summary>
    /// <param name="aggregate">The aggregate.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The aggregate is not one this build defines.</exception>
    public static string ToText(RollupAggregate aggregate) => aggregate switch
    {
        RollupAggregate.Count => "count",
        RollupAggregate.Sum => "sum",
        RollupAggregate.Min => "min",
        RollupAggregate.Max => "max",
        RollupAggregate.Average => "average",
        RollupAggregate.Any => "any",
        RollupAggregate.All => "all",
        _ => throw new ArgumentOutOfRangeException(
            nameof(aggregate),
            aggregate,
            "Unknown rollup aggregate."),
    };

    /// <summary>Whether this aggregate can be computed without naming a property.</summary>
    /// <param name="aggregate">The aggregate.</param>
    /// <returns><see langword="true"/> only for <see cref="RollupAggregate.Count"/>.</returns>
    public static bool CountsChildren(this RollupAggregate aggregate) =>
        aggregate is RollupAggregate.Count;

    /// <summary>Whether this aggregate reduces to a number.</summary>
    /// <param name="aggregate">The aggregate.</param>
    /// <returns><see langword="true"/> for the four numeric reductions and for a count.</returns>
    /// <remarks>
    /// Asked rather than compared against a list at the call sites, so the reader that turns a row
    /// into a value and the rule that says which source types make sense cannot drift apart.
    /// </remarks>
    public static bool IsNumeric(this RollupAggregate aggregate) =>
        aggregate is RollupAggregate.Count or RollupAggregate.Sum or RollupAggregate.Min
            or RollupAggregate.Max or RollupAggregate.Average;
}
