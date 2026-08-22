using System.Globalization;
using System.Text.Json.Nodes;

namespace Nix.Domain.Properties;

/// <summary>
/// One property folded across one item's children, in every way a rollup can reduce it.
/// </summary>
/// <param name="Children">How many children the item has.</param>
/// <param name="Present">How many of them carry a value for this property.</param>
/// <param name="Numbers">How many of those values are numbers.</param>
/// <param name="Total">
/// The sum of the numeric values, or null when there are none - and also null when the total is too
/// large to represent, which the fold bounds rather than crashes on. <see cref="Numbers"/> is what
/// tells the two apart.
/// </param>
/// <param name="Smallest">The least numeric value, or null when there are none.</param>
/// <param name="Largest">The greatest numeric value, or null when there are none.</param>
/// <param name="Booleans">How many of the values are true or false.</param>
/// <param name="Truths">How many of them are true.</param>
/// <remarks>
/// <para>
/// <b>Every fold, not the one that was asked for.</b> The statement computes them all in one pass
/// over rows it is already scanning, so the reduction a property declared is chosen here rather
/// than in SQL - which is what keeps the aggregate name out of statement text. See
/// <c>RollupSql.AggregateChildProperties</c>.
/// </para>
/// <para>
/// <b>Decimal, not double.</b> A rollup sums money and estimates, and a total that drifts in the
/// last digits because it went through binary floating point is a number somebody will check
/// against a calculator and find wrong. Postgres <c>numeric</c> maps to <see cref="decimal"/>
/// exactly.
/// </para>
/// </remarks>
public readonly record struct ChildAggregate(
    long Children,
    long Present,
    long Numbers,
    decimal? Total,
    decimal? Smallest,
    decimal? Largest,
    long Booleans,
    long Truths)
{
    /// <summary>What every fold answers for an item with no children at all.</summary>
    /// <remarks>
    /// Not the same as "no answer". An empty container's count is zero and its "all" is true, which
    /// is what an empty conjunction means - reporting either as absent would leave a rollup column
    /// blank on exactly the rows a person is most likely to be checking.
    /// </remarks>
    public static readonly ChildAggregate Empty = new(0, 0, 0, null, null, null, 0, 0);

    /// <summary>Reduces this fold the way one aggregate does.</summary>
    /// <param name="aggregate">Which reduction the property declared.</param>
    /// <param name="sourceless">
    /// Whether the rollup named no property to fold, which is the "how many things are in here"
    /// question. Named for what it is rather than for what a count does with it: the neighbouring
    /// <c>RollupAggregates.CountsChildren</c> asks whether a fold <em>may</em> omit a source, and a
    /// maintainer passing one where the other belongs would turn a count of the children carrying
    /// a value into a count of the children, silently and plausibly.
    /// </param>
    /// <returns>
    /// The value, or <see langword="null"/> when the fold has nothing to reduce - an average or an
    /// extreme over no numbers at all. Null is published as null rather than as zero, because zero
    /// is a real answer a person would act on and "nothing to average" is not.
    /// </returns>
    public JsonNode? Reduce(RollupAggregate aggregate, bool sourceless) => aggregate switch
    {
        RollupAggregate.Count => JsonValue.Create(sourceless ? Children : Present),

        // Zero when there was nothing to add up, which is what an empty sum is - but no answer
        // when there were numbers and their total will not fit, because a zero there is a figure
        // somebody would act on and the fold deliberately declined to compute it.
        RollupAggregate.Sum => Total is { } sum
            ? JsonValue.Create(sum)
            : Numbers == 0 ? JsonValue.Create(0m) : null,
        RollupAggregate.Min => Smallest is { } least ? JsonValue.Create(least) : null,
        RollupAggregate.Max => Largest is { } most ? JsonValue.Create(most) : null,

        // Over the values that exist, never over the blanks. An average that counted a child with
        // no estimate as a zero would fall as somebody added rows they had not filled in yet.
        RollupAggregate.Average => Numbers > 0 && Total is { } sum
            ? JsonValue.Create(decimal.Round(sum / Numbers, 6, MidpointRounding.ToEven))
            : null,

        RollupAggregate.Any => JsonValue.Create(Truths > 0),

        // True of nothing, as an empty conjunction is - but only when there was genuinely nothing
        // to judge. A container of three hundred children none of whose values is a boolean is not
        // a container where everything is true; answering true there is the most damaging possible
        // default for the most misleading possible reason, so it answers nothing instead and the
        // column says so.
        RollupAggregate.All => Booleans > 0
            ? JsonValue.Create(Truths == Booleans)
            : Present == 0 ? JsonValue.Create(true) : null,

        _ => throw new ArgumentOutOfRangeException(
            nameof(aggregate),
            aggregate,
            "Unknown rollup aggregate."),
    };

    /// <summary>This fold as text, for a log or a failure message.</summary>
    /// <returns>The counts, in one line.</returns>
    public override string ToString() => string.Create(
        CultureInfo.InvariantCulture,
        $"children={Children} present={Present} numbers={Numbers} booleans={Booleans} truths={Truths}");
}
