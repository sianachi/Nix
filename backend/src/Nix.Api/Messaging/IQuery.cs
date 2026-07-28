namespace Nix.Messaging;

/// <summary>
/// A request that reads without changing anything, carrying the type its handler returns.
/// </summary>
/// <typeparam name="TResult">
/// Exactly what the handler returns - <c>Result&lt;Item&gt;</c> for a read that can fail,
/// a bare <c>IReadOnlySet&lt;ItemId&gt;</c> for one that cannot.
/// </typeparam>
/// <remarks>
/// <para>
/// <b>Queries differ from commands here on purpose.</b> A command always returns
/// <c>Result&lt;TValue&gt;</c>; a query says what it returns. Reads split cleanly into two kinds
/// and forcing the second kind through <c>Result</c> would make every caller unwrap a failure that
/// cannot happen. Asking "which item ids in this page have children" has no failure case - the
/// answer to an invisible item is simply that it is absent from the set.
/// </para>
/// <para>
/// Permission filtering happens inside the handler's query, never after it returns. A query that
/// hands back rows for the caller to filter is the bug this codebase is built to prevent.
/// </para>
/// </remarks>
#pragma warning disable CA1040 // Justification: a dispatch marker, not an empty contract. It carries
// TResult, which is what binds a query to its handler's return type in NixDispatcher's constraint.
public interface IQuery<TResult>;
#pragma warning restore CA1040
