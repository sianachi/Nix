namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The one way a statement reads a property value as a number: a stored JSON number, within a
/// magnitude a <see cref="decimal"/> can carry, and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// <b>JSON numbers only, never number-shaped text.</b> Postgres' <c>numeric</c> input trims
/// whitespace by the server locale and rejects what a pattern written here would accept (an
/// ideographic space, an em space, an unbounded digit run), and one such value fails the whole
/// statement with 22P02 - every query, view and aggregate over that key at once. A JSON number's
/// text is always valid <c>numeric</c> input, so the cast below cannot throw. A string that looks
/// like a number is therefore not a number: a fold counts it as skipped and a comparison skips it.
/// </para>
/// <para>
/// <b>The cast sits inside a nested CASE, never beside the type test in one AND</b>, because
/// Postgres does not promise the order it evaluates AND's operands in; CASE it does.
/// </para>
/// <para>
/// Shared by <see cref="RollupSql"/> and <see cref="QuerySql"/> so the two readings of "a number"
/// cannot drift. The bag and key are SQL expressions the caller owns - a column reference and a
/// bound parameter or column - never input text.
/// </para>
/// </remarks>
public static class NumberSql
{
    /// <summary>The largest magnitude one value may have to be read: rollups' bound, since goal 2.2.</summary>
    public const string ValueBound = "1e15";

    /// <summary>The largest magnitude a total may have and still be answered.</summary>
    public const string TotalBound = "1e28";

    /// <summary>The value as <c>numeric</c> when it is a stored JSON number, else null.</summary>
    /// <param name="bag">The jsonb expression holding the property bag, such as <c>item.properties</c>.</param>
    /// <param name="key">The key expression, such as <c>@p0_key</c> or <c>k.key</c>.</param>
    /// <returns>A SQL expression.</returns>
    public static string Number(string bag, string key) =>
        $"(CASE WHEN jsonb_typeof({bag} -> {key}) = 'number' THEN ({bag} ->> {key})::numeric END)";

    /// <summary>
    /// <see cref="Number"/>, further bounded to <see cref="ValueBound"/>: null for a larger value,
    /// which a fold then reports as not counted rather than overflowing the reader.
    /// </summary>
    /// <param name="bag">The jsonb expression holding the property bag.</param>
    /// <param name="key">The key expression.</param>
    /// <returns>A SQL expression.</returns>
    public static string Bounded(string bag, string key) =>
        $"(CASE WHEN jsonb_typeof({bag} -> {key}) = 'number' THEN CASE WHEN abs(({bag} ->> {key})::numeric) <= {ValueBound} THEN ({bag} ->> {key})::numeric END END)";

    /// <summary>The sum of an expression, or null when its magnitude passes <see cref="TotalBound"/>.</summary>
    /// <param name="expression">A <see cref="Bounded"/> expression or a column holding one.</param>
    /// <returns>A SQL aggregate expression.</returns>
    public static string CappedSum(string expression) =>
        $"(CASE WHEN abs(sum({expression})) <= {TotalBound} THEN sum({expression}) END)";
}
