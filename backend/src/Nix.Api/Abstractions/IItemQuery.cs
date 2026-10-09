using System.Collections.Immutable;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using NodaTime;

namespace Nix.Abstractions;

/// <summary>
/// Runs a query: rules compiled and executed server-side, filtered by what the caller may read
/// while the statement runs. The saved query view and the ad-hoc workspace query both arrive here,
/// so there is one statement builder and one rule engine.
/// </summary>
/// <remarks>
/// A port for the same reason <see cref="IWorkspaceCalendar"/> is one: the implementation is
/// persistence knowledge end to end - hand-written SQL over the property bags - and the handlers'
/// tests need a fake that answers without a database. The rules arrive already re-validated by the
/// handler; an implementation may treat an operator outside <see cref="QueryOperators"/> as a bug.
/// </remarks>
public interface IItemQuery
{
    /// <summary>Runs the query and returns its rows.</summary>
    /// <param name="spec">What to match, how to order and group it, and where to look.</param>
    /// <param name="readableWorkspaces">Every workspace the caller may read; the predicate.</param>
    /// <param name="limit">The most rows to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The matches, their groups, and whether the limit cut them.</returns>
    public ValueTask<QueryResults> RunAsync(
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>
    /// Runs the same match and folds it instead of returning rows: a count, total, mean, least or
    /// greatest over every matched row, optionally per group.
    /// </summary>
    /// <param name="spec">What to match and how to group it; its order is not used.</param>
    /// <param name="aggregate">The fold.</param>
    /// <param name="readableWorkspaces">Every workspace the caller may read; the predicate.</param>
    /// <param name="maximumGroups">The most groups to return; the totals still cover every row.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The groups, the totals, and how many values could not be read as numbers.</returns>
    public ValueTask<QueryAggregateResults> AggregateAsync(
        QuerySpec spec,
        QueryAggregate aggregate,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int maximumGroups,
        CancellationToken cancellationToken);
}

/// <summary>The saved-view call shape, kept so callers that run a smart list read as they did.</summary>
public static class ItemQueryExtensions
{
    /// <summary>Runs a smart list's rules: everything readable except the smart list itself.</summary>
    /// <param name="query">The port.</param>
    /// <param name="queryItemId">The smart list itself, which never lists itself.</param>
    /// <param name="rules">The re-validated rules. Empty matches everything readable.</param>
    /// <param name="order">How the rows are ordered.</param>
    /// <param name="today">The caller's own today, resolving the day tokens.</param>
    /// <param name="readableWorkspaces">Every workspace the caller may read; the predicate.</param>
    /// <param name="limit">The most rows to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The matches and whether the limit cut them.</returns>
    public static ValueTask<QueryResults> RunAsync(
        this IItemQuery query,
        ItemId queryItemId,
        ImmutableArray<FilterRule> rules,
        QueryOrder order,
        DateOnly today,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        return query.RunAsync(
            new QuerySpec(rules, order, today) { ExcludedItemId = queryItemId },
            readableWorkspaces,
            limit,
            cancellationToken);
    }
}

/// <summary>Everything one query asks, except whose permissions it runs under.</summary>
/// <param name="Rules">The re-validated rules, ANDed, with at most one level of "any of" groups.</param>
/// <param name="Order">How the rows are ordered within their group.</param>
/// <param name="Today">The caller's own today, resolving the day tokens and windows.</param>
public sealed record QuerySpec(ImmutableArray<FilterRule> Rules, QueryOrder Order, DateOnly Today)
{
    /// <summary>An item never to return - the smart list running its own query - or null.</summary>
    public ItemId? ExcludedItemId { get; init; }

    /// <summary>Where to look beneath, or null for every readable workspace in the predicate.</summary>
    public QueryScope? Scope { get; init; }

    /// <summary>What to group by, or null for one ungrouped list.</summary>
    public QueryGrouping? Grouping { get; init; }

    /// <summary>
    /// The caller's zone, in which <c>$created</c> and <c>$modified</c> days begin and end. The
    /// handler resolves it from the caller's own preferences; UTC when they name none.
    /// </summary>
    public DateTimeZone Zone { get; init; } = DateTimeZone.Utc;
}

/// <summary>A query limited to one container's subtree or its direct children.</summary>
/// <param name="ParentId">
/// The container. The handler has already proven the caller may read it; the statement does not
/// re-ask, but its rows still carry the full readable-workspace predicate.
/// </param>
/// <param name="Descendants">
/// <see langword="true"/> for everything beneath (the closure), <see langword="false"/> for the
/// direct children only (<c>parent_id</c>).
/// </param>
public sealed record QueryScope(ItemId ParentId, bool Descendants);

/// <summary>How rows are grouped.</summary>
/// <param name="Key">
/// A property key whose stored string, true/false or numeric value names the group, or <see cref="QueryFields.Type"/>.
/// Any other stored shape (a list, an object, an empty string, absence) falls into the "no value" group.
/// </param>
/// <param name="Order">
/// Group keys in the order the caller wants them - a select's option order, which only a schema
/// knows and a cross-container query has none of. Keys not named sort after these, by text, with
/// the "no value" group last.
/// </param>
public sealed record QueryGrouping(string Key, ImmutableArray<string> Order);

/// <summary>How a query's rows are ordered.</summary>
/// <param name="Key">
/// The property key to order by, one of <see cref="QueryFields.Sortable"/>, or
/// <see langword="null"/> for most recently modified first.
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

/// <summary>A query statement the database refused to finish - timed out, or failed on stored data.</summary>
/// <remarks>
/// Raised by the query port in place of a raw database error, so the handlers can answer a stable
/// code rather than a 500. The rules were validated before the statement ran, so a failure here is
/// about time or data, never about the caller's grammar.
/// </remarks>
public sealed class ItemQueryFailedException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="ItemQueryFailedException"/> class.</summary>
    /// <param name="timedOut">Whether the statement ran past its timeout.</param>
    /// <param name="sqlState">The database's error code, for the log.</param>
    /// <param name="inner">The database error.</param>
    public ItemQueryFailedException(bool timedOut, string sqlState, Exception inner)
        : base(timedOut ? "The query ran past its time limit." : $"The query could not run ({sqlState}).", inner)
    {
        TimedOut = timedOut;
        SqlState = sqlState;
    }

    /// <summary>Initializes a new instance of the <see cref="ItemQueryFailedException"/> class.</summary>
    public ItemQueryFailedException()
    {
        SqlState = string.Empty;
    }

    /// <summary>Initializes a new instance of the <see cref="ItemQueryFailedException"/> class.</summary>
    /// <param name="message">What happened.</param>
    public ItemQueryFailedException(string message)
        : base(message)
    {
        SqlState = string.Empty;
    }

    /// <summary>Initializes a new instance of the <see cref="ItemQueryFailedException"/> class.</summary>
    /// <param name="message">What happened.</param>
    /// <param name="innerException">The cause.</param>
    public ItemQueryFailedException(string message, Exception innerException)
        : base(message, innerException)
    {
        SqlState = string.Empty;
    }

    /// <summary>Whether the statement ran past its timeout rather than failing on data.</summary>
    public bool TimedOut { get; }

    /// <summary>The database's error code.</summary>
    public string SqlState { get; }
}
