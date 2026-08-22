using System.Collections.Immutable;
using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Query;

/// <summary>Runs the saved query one of an item's views stores.</summary>
/// <param name="ItemId">The smart list - the item whose view holds the rules.</param>
/// <param name="ViewId">Which of its views to run.</param>
/// <param name="Today">
/// The caller's own today, <c>yyyy-MM-dd</c>. Sent on every read because only the caller's zone
/// decides which day it is, and a saved query stores the rule (<c>today</c>) rather than a date.
/// </param>
/// <remarks>
/// <b>The client names the view; it never sends rules.</b> The stored view is the whole query -
/// a caller who could supply rules could project any property of every item it can read, and
/// probe ones it cannot. The calendar makes the same argument for its own config; ADR-0039
/// records this one.
/// </remarks>
public sealed record RunItemQuery(ItemId ItemId, string ViewId, string Today)
    : IQuery<Result<ItemQueryResults>>;

/// <summary>What a run answered, with what it was asked echoed for the response.</summary>
/// <param name="Results">The matches and the truncation flag.</param>
/// <param name="ViewId">The view that ran.</param>
/// <param name="Today">The day the <c>today</c> token resolved to.</param>
/// <param name="Limit">The ceiling the run applied.</param>
public sealed record ItemQueryResults(QueryResults Results, string ViewId, string Today, int Limit);

/// <summary>Handles <see cref="RunItemQuery"/>.</summary>
public sealed class RunItemQueryHandler : IQueryHandler<RunItemQuery, Result<ItemQueryResults>>
{
    /// <summary>The most rows one run returns.</summary>
    /// <remarks>
    /// A fixed ceiling with a truncation flag rather than a cursor: a cross-container result set
    /// has no stable global order for a cursor to page over, and a smart list past this size is
    /// not a list anyone reads. Goal 3.9 owns 10k-scale and can add keyset paging if measurement
    /// demands it.
    /// </remarks>
    public const int MaximumResults = 500;

    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly IItemQuery _query;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes a new instance of the <see cref="RunItemQueryHandler"/> class.</summary>
    /// <param name="tree">Item storage, for the smart list itself.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    /// <param name="query">Runs the compiled query.</param>
    /// <param name="session">
    /// The acting principal, used to resolve the <see cref="QueryOperators.Me"/> token. Never the
    /// client - see <see cref="QueryOperators.Me"/> for why that would defeat the check.
    /// </param>
    public RunItemQueryHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        IItemQuery query,
        INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(session);

        _tree = tree;
        _permissions = permissions;
        _query = query;
        _session = session;
    }

    /// <summary>Runs the query.</summary>
    /// <param name="query">The item, the view, and the caller's today.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The matches, or why the run was refused.</returns>
    public async ValueTask<Result<ItemQueryResults>> HandleAsync(
        RunItemQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        // Exact-parsed, the calendar's own rule and reasons: a malformed day compares happily as
        // text and would silently return nothing, which a reader reads as "nothing matches".
        if (!DateOnly.TryParseExact(query.Today, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var today))
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.InvalidToday($"'{query.Today}' is not a day; send today as yyyy-MM-dd."));
        }

        // Loud rather than guessed: there is no anonymous path to this query (every route under
        // /api/v1 is authenticated, Program.cs), so a missing context here is a bug in the
        // pipeline that established the unit of work, not an input this handler can refuse
        // gracefully. Silently skipping the "me" resolution would either match nobody's items or,
        // worse, everybody's - both are the wrong kind of quiet.
        var caller = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this unit of work. Resolving the "
                + "'me' token needs an acting principal, and there is no anonymous path to this "
                + "query.");

        var item = await _tree.FindAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemQueryResults>(ItemErrors.NotFound($"No item {query.ItemId} is visible."));
        }

        var stored = ViewDefinitionsJson.Read(item.Views);
        ViewDefinition? view = null;
        foreach (var candidate in stored.Views)
        {
            if (string.Equals(candidate.Id, query.ViewId, StringComparison.Ordinal))
            {
                view = candidate;
                break;
            }
        }

        if (view is null)
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.ViewNotFound($"This item has no view '{query.ViewId}'."));
        }

        if (view.Kind != ViewKind.Query)
        {
            return Result.Failure<ItemQueryResults>(
                QueryErrors.ViewNotFound($"'{query.ViewId}' is not a query view, so it has nothing to run."));
        }

        // Re-validated at execution, fail-closed: the stored JSON reader is fail-soft per rule,
        // and a dropped rule can only ever WIDEN a query. Refusing to run a set that no longer
        // passes is what keeps that widening from silently disclosing rows the saved query never
        // asked for.
        var rules = view.Filters.IsDefaultOrEmpty ? [] : view.Filters;
        foreach (var rule in rules)
        {
            if (QueryOperators.Refuse(rule) is { } reason)
            {
                return Result.Failure<ItemQueryResults>(
                    QueryErrors.InvalidRules(
                        $"A stored filter no longer validates ({reason}), so the query was not "
                        + "run. Edit the view's filters and save them again."));
            }
        }

        // Resolved here, not in the compiler: QuerySql is a static class with no session to read
        // a principal from, and the same argument that keeps "today" client-supplied keeps "me"
        // the opposite - never client-supplied - so this is the one place both facts are in
        // scope at once. What reaches the query port is already a literal; see QuerySql's remarks.
        var resolvedRules = ResolveCaller(rules, caller.PrincipalId.ToString());

        var workspaces = await _permissions.ReadableWorkspacesAsync(cancellationToken).ConfigureAwait(false);

        var results = await _query
            .RunAsync(query.ItemId, resolvedRules, ResolveOrder(view, resolvedRules), today, workspaces, MaximumResults, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new ItemQueryResults(results, view.Id, ToIso(today), MaximumResults));
    }

    /// <summary>
    /// Replaces <see cref="QueryOperators.Me"/> wherever it appears as a rule's value with the
    /// caller's own canonical identifier - the exact lowercase text an <c>assignee</c> property
    /// stores (<c>PrincipalId.ToString()</c>), so the comparison downstream actually matches.
    /// </summary>
    /// <param name="rules">
    /// The re-validated rules. Grammar already guarantees <see cref="QueryOperators.Me"/> can only
    /// survive here as the value of <see cref="QueryOperators.EqualTo"/> or
    /// <see cref="QueryOperators.NotEqualTo"/> - every other operator refuses it before this runs.
    /// </param>
    /// <param name="callerId">The acting principal's canonical identifier.</param>
    /// <returns>The rules, with every <c>me</c> value replaced; everything else untouched.</returns>
    private static ImmutableArray<FilterRule> ResolveCaller(ImmutableArray<FilterRule> rules, string callerId)
    {
        if (rules.IsDefaultOrEmpty)
        {
            return rules;
        }

        var resolved = ImmutableArray.CreateBuilder<FilterRule>(rules.Length);
        foreach (var rule in rules)
        {
            resolved.Add(string.Equals(rule.Value, QueryOperators.Me, StringComparison.Ordinal)
                ? rule with { Value = callerId }
                : rule);
        }

        return resolved.ToImmutable();
    }

    /// <summary>
    /// How the rows are ordered: the first date-shaped rule's property ascending - soonest first,
    /// which is what Today, Next-7-days and Overdue all want - else the view's own sort, else
    /// most recently modified first.
    /// </summary>
    private static QueryOrder ResolveOrder(
        ViewDefinition view,
        System.Collections.Immutable.ImmutableArray<FilterRule> rules)
    {
        foreach (var rule in rules)
        {
            if (QueryOperators.ReadsDay(rule.Operator)
                || string.Equals(rule.Operator, QueryOperators.WithinNext, StringComparison.Ordinal))
            {
                return new QueryOrder(rule.Property, IsDay: true, Descending: false);
            }
        }

        if (view.SortBy is { Length: > 0 } sortBy)
        {
            // Lexical ordering over the property text - a number sorts as text. Stated in the
            // published description rather than hidden; precise typed ordering is a later goal's
            // problem, with the schema knowledge it needs.
            return new QueryOrder(sortBy, IsDay: false, view.SortDescending);
        }

        return QueryOrder.Recency;
    }

    private static string ToIso(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>
/// Route handler for running a saved query.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RunItemQuery"/> itself, the same disambiguation every feature's
/// endpoint class makes.
/// </remarks>
internal static class RunItemQueryEndpoint
{
    /// <summary>Handles a request to run one of an item's query views.</summary>
    /// <param name="itemId">The smart list.</param>
    /// <param name="view">Which of its views to run.</param>
    /// <param name="today">The caller's own today, yyyy-MM-dd.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The matches, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<QueryResultsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        [FromQuery] string? view,
        [FromQuery] string? today,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (string.IsNullOrEmpty(view))
        {
            return TypedResults.Problem(
                QueryEndpoints.Problem(
                    httpContext,
                    QueryErrors.ViewNotFound("Name the view to run: ?view=<view id>.")));
        }

        if (string.IsNullOrEmpty(today))
        {
            return TypedResults.Problem(
                QueryEndpoints.Problem(
                    httpContext,
                    QueryErrors.InvalidToday("Send the caller's day: ?today=yyyy-MM-dd.")));
        }

        var result = await dispatcher
            .QueryAsync<RunItemQuery, Result<ItemQueryResults>>(
                new RunItemQuery(ItemId.From(itemId), view, today),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<QueryResultsResponse>, ProblemHttpResult>>(
            run => TypedResults.Ok(QueryMapping.ToResponse(itemId, run)),
            error => TypedResults.Problem(QueryEndpoints.Problem(httpContext, error)));
    }
}
