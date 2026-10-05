using Npgsql;

namespace Nix.Persistence.Sql;

/// <summary>
/// Maps one row of a hand-written SQL result into a domain-shaped value.
/// </summary>
/// <typeparam name="TRow">The mapped row type.</typeparam>
/// <remarks>
/// <para>
/// An interface rather than a <c>Func&lt;NpgsqlDataReader, TRow&gt;</c> so that mappers can be
/// <see langword="struct"/>s: <see cref="NixSqlExecutor"/> takes the mapper as a generic type
/// parameter, so a struct mapper is monomorphised and the call devirtualised, and no delegate or
/// closure is allocated per query. That matters because the callers are the hot paths - closure
/// walks, permission predicates, search - where a per-row delegate invocation is measurable.
/// </para>
/// <para>
/// <b>Read columns strictly left to right, and each one exactly once.</b> The reader is opened
/// with <c>CommandBehavior.SequentialAccess</c>, which streams the row off the wire instead of
/// buffering it. Reading a column twice, or out of order, throws.
/// </para>
/// <para>
/// Do not materialise binary columns here. For <c>bytea</c>, project the row without the payload
/// and stream the bytes with <see cref="NixSqlExecutor.OpenColumnStreamAsync"/>.
/// </para>
/// </remarks>
public interface INixRowMapper<out TRow>
{
    /// <summary>
    /// Maps the row the reader is currently positioned on.
    /// </summary>
    /// <param name="reader">A reader positioned on a row, in sequential-access mode.</param>
    /// <returns>The mapped row.</returns>
    public TRow Map(NpgsqlDataReader reader);
}
