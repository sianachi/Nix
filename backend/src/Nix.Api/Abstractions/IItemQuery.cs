using System.Collections.Immutable;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;

namespace Nix.Abstractions;

/// <summary>
/// Runs a saved query: the stored rules of a query view, compiled and executed server-side,
/// filtered by what the caller may read while the statement runs.
/// </summary>
/// <remarks>
/// A port for the same reason <see cref="IWorkspaceCalendar"/> is one: the implementation is
/// persistence knowledge end to end - hand-written SQL over the property bags - and the handler's
/// tests need a fake that answers without a database. The rules arrive already re-validated by the
/// handler; an implementation may treat an operator outside <see cref="QueryOperators"/> as a bug.
/// </remarks>
public interface IItemQuery
{
    /// <summary>Runs the query.</summary>
    /// <param name="queryItemId">The smart list itself, which never lists itself.</param>
    /// <param name="rules">The re-validated rules, AND-combined. Empty matches everything readable.</param>
    /// <param name="order">How the rows are ordered.</param>
    /// <param name="today">The caller's own today, resolving the <c>today</c> token.</param>
    /// <param name="readableWorkspaces">Every workspace the caller may read; the predicate.</param>
    /// <param name="limit">The most rows to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The matches and whether the limit cut them.</returns>
    public ValueTask<QueryResults> RunAsync(
        ItemId queryItemId,
        ImmutableArray<FilterRule> rules,
        QueryOrder order,
        DateOnly today,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);
}

/// <summary>How a query's rows are ordered.</summary>
/// <param name="Key">
/// The property key to order by, or <see langword="null"/> for most recently modified first.
/// </param>
/// <param name="IsDay">
/// Whether the key holds dates, in which case the first ten characters are compared - never a
/// cast, because stored timestamps carry a bracketed zone Postgres will not parse.
/// </param>
/// <param name="Descending">Which way. Ignored when <see cref="Key"/> is null (always newest first).</param>
/// <remarks>
/// Always tie-broken by the item id in the statement, so the same query reads the same twice -
/// a truncated list that reshuffles between reads would look like items appearing and vanishing.
/// </remarks>
public sealed record QueryOrder(string? Key, bool IsDay, bool Descending)
{
    /// <summary>Most recently modified first - what an unconfigured query view shows.</summary>
    public static readonly QueryOrder Recency = new(null, false, false);
}
