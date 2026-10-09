using System.Collections.Immutable;
using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Features.Views;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Query;

/// <summary>
/// Route registration for the query feature: a saved cross-container query and the ad-hoc
/// workspace query, both run server-side through one evaluator and one statement builder.
/// </summary>
/// <remarks>
/// Registered under <c>/api/v1</c>, which is what authenticates it - the path is the policy. Its
/// own feature rather than a shape on the views routes: reading a container's views answers "how
/// may this be looked at", and this answers "what matches", which is a bulk read with its own
/// ceiling, its own honesty fields and its own security posture (ADR-0039).
/// </remarks>
internal static class QueryEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    /// <remarks>
    /// The same literal the items feature publishes - asking to run an item's query is asking for
    /// the item. Spelled out rather than referenced, the calendar's own precedent: this feature
    /// owns its contract, and a test asserts the two features agree.
    /// </remarks>
    internal const string ItemNotFoundCode = "items.not_found";

    /// <summary>Stable code for a today parameter that is missing or not a day.</summary>
    internal const string InvalidTodayCode = "query.invalid_today";

    /// <summary>Stable code for "this item has no such query view".</summary>
    internal const string ViewNotFoundCode = "query.view_not_found";

    /// <summary>Stable code for stored rules that no longer validate.</summary>
    internal const string InvalidRulesCode = "query.invalid_rules";

    /// <summary>Stable code for an ad-hoc query the grammar refuses.</summary>
    internal const string InvalidRequestCode = "query.invalid_request";

    /// <summary>The literal the workspaces feature publishes for "no such workspace, or not visible".</summary>
    internal const string WorkspaceNotFoundCode = "workspaces.not_found";

    /// <summary>The largest ad-hoc query body accepted.</summary>
    /// <remarks>
    /// Eight rules of at most 512-character values, a group order of at most 100 keys of at most
    /// 128 characters, every character escaped, and the envelope: under this, so a body over it is
    /// not a query. A test holds the largest legitimate body under it.
    /// </remarks>
    internal const long RequestBodyLimit = 128 * 1024;

    /// <summary>Registers the query feature's routes on <paramref name="endpoints"/>.</summary>
    /// <param name="endpoints">The application's route table.</param>
    /// <returns><paramref name="endpoints"/>, for chaining.</returns>
    internal static IEndpointRouteBuilder MapQueryEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Query");

        items.MapGet("/{itemId:guid}/query", RunItemQueryEndpoint.Handle)
            .WithName("RunItemQuery")
            .WithSummary("Run one of an item's query views")
            .WithDescription(
                "Runs the saved query the named view stores: every active item the caller may "
                + "read, in any container, whose properties satisfy the view's filters. The "
                + "client names the view and never sends rules - the stored view is the whole "
                + "query, and rules are edited through PUT /items/{itemId}/views like any other "
                + "view configuration. 'today' is required, as yyyy-MM-dd in the caller's own "
                + "zone, because a stored rule may say 'today' and only the caller knows which "
                + "day that is. Rows the caller may not read are excluded while the query runs, "
                + "never filtered from its results, so the ceiling is spent only on rows that "
                + "are actually returned. Results are ordered by the first date-shaped filter's "
                + "property soonest-first, else by the view's own sort compared as text, else "
                + "most recently modified first, and always tie-broken by id so the same read "
                + "returns the same rows twice. At most "
                + Ceiling
                + " rows are returned; 'truncated' says when more matched, which a list cannot "
                + "convey on its own. Each row carries its container's title so a cross-container "
                + "list can say where a row lives. Items under a lock the caller has not opened "
                + "are left out, and a view stored on a locked item is refused with "
                + "'items.locked' (423) until it is unlocked.");

        var workspaces = endpoints.MapGroup("/api/v1/workspaces").WithTags("Query");

        workspaces.MapPost("/{workspaceId:guid}/query", RunWorkspaceQueryEndpoint.Handle)
            .WithName("RunWorkspaceQuery")
            .WithSummary("Run an ad-hoc query over one workspace")
            .WithDescription(
                "Runs the rule shape a query view stores, without a saved view, over one workspace "
                + "the caller may read: every active item that satisfies 'filters' (ANDed, with one "
                + "level of 'any' groups, at most eight with the preset's), optionally beneath "
                + "'scope.parentId' (its whole subtree unless 'descendants' is false). Rules may "
                + "test properties or the structural fields $type, $inside, $created, $modified and "
                + "$done. Rows the caller may not read are excluded while the query runs, so the "
                + "limit (100 by default, at most "
                + Ceiling
                + ") is spent only on rows that are returned; 'truncated' says when more matched. "
                + "With 'groupBy', rows arrive group by group - in 'groupBy.order', then by text, "
                + "with 'no value' last - and 'groups' lists each group with its full count, so a "
                + "cut list has whole groups first. Rows are otherwise ordered by 'sort', else by "
                + "the first date rule's property soonest first, else most recently modified "
                + "first, always tie-broken by id. 'today' (yyyy-MM-dd, the caller's own day) is "
                + "required when a rule uses a day token or a window. A workspace the caller cannot "
                + "read answers 'workspaces.not_found'; a scope container it cannot read answers "
                + "'items.not_found', as the item read does, and a locked one 'items.locked'. A "
                + "read sent as a POST because rules do not fit a URL: it changes nothing, a "
                + "read-scoped token may call it, and it has its own per-address rate limit "
                + "('queries'), separate from writes.")
            .Accepts<WorkspaceQueryRequest>("application/json")
            .Produces<WorkspaceQueryResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status423Locked)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .WithRequestBodyLimit(RequestBodyLimit)
            .RequireRateLimiting(RateLimitRefusal.QueriesPolicyName);

        workspaces.MapPost("/{workspaceId:guid}/query/aggregate", AggregateWorkspaceQueryEndpoint.Handle)
            .WithName("AggregateWorkspaceQuery")
            .WithSummary("Fold an ad-hoc query over one workspace")
            .WithDescription(
                "Matches exactly what POST /workspaces/{workspaceId}/query would - same rules, "
                + "scope, permission, lifecycle and lock filters - and folds the matches instead of "
                + "returning them: 'count' rows, or 'sum', 'avg', 'min' or 'max' of a numeric "
                + "property. A stored number, or text that reads as one, is folded; any other value "
                + "is left out and counted in 'skipped', never treated as zero. With 'groupBy' the "
                + "fold is also given per group, at most "
                + GroupCeiling
                + " groups in the same order a grouped query uses, with 'truncated' and "
                + "'groupCount' saying when more exist; 'total', 'count' and 'skipped' always cover "
                + "every matched row. Same refusals, token scope and rate limit as the query.")
            .Accepts<WorkspaceAggregateRequest>("application/json")
            .Produces<WorkspaceAggregateResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status423Locked)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .WithRequestBodyLimit(RequestBodyLimit)
            .RequireRateLimiting(RateLimitRefusal.QueriesPolicyName);

        return endpoints;
    }

    /// <summary>Maps a query failure onto problem details.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Total over the codes this feature can raise plus the items code it reuses, and 500 for
    /// anything else - the calendar's rule, for the calendar's reason: a forgotten code must not
    /// reach clients as the one status they already handle.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            ItemNotFoundCode => StatusCodes.Status404NotFound,
            ItemEndpoints.LockedCode => StatusCodes.Status423Locked,
            ViewNotFoundCode => StatusCodes.Status404NotFound,
            InvalidTodayCode => StatusCodes.Status400BadRequest,
            InvalidRulesCode => StatusCodes.Status422UnprocessableEntity,
            InvalidRequestCode => StatusCodes.Status400BadRequest,
            WorkspaceNotFoundCode => StatusCodes.Status404NotFound,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    /// <summary>The ceiling as the published description spells it.</summary>
    /// <remarks>Read off the handler rather than typed, so raising it cannot leave prose stale.</remarks>
    private static string Ceiling =>
        RunItemQueryHandler.MaximumResults.ToString("N0", CultureInfo.InvariantCulture);

    private static string GroupCeiling =>
        WorkspaceQueryHandler.MaximumGroups.ToString("N0", CultureInfo.InvariantCulture);
}

/// <summary>Maps the ad-hoc request shapes onto the use case's input.</summary>
internal static class WorkspaceQueryRequests
{
    /// <summary>The input, or the sentence refusing the request's shape.</summary>
    /// <param name="workspaceId">The workspace named by the route.</param>
    /// <param name="scope">The scope as sent.</param>
    /// <param name="preset">The preset as sent.</param>
    /// <param name="filters">The rules as sent.</param>
    /// <param name="sort">The sort as sent.</param>
    /// <param name="groupBy">The grouping as sent.</param>
    /// <param name="today">The caller's day as sent.</param>
    /// <param name="refusal">Why the shape was refused.</param>
    /// <returns>The input, or <see langword="null"/> with <paramref name="refusal"/> set.</returns>
    internal static WorkspaceQueryInput? ToInput(
        Guid workspaceId,
        QueryScopeContract? scope,
        string? preset,
        IReadOnlyList<FilterRuleContract>? filters,
        QuerySortContract? sort,
        QueryGroupByContract? groupBy,
        string? today,
        out string? refusal)
    {
        if (FilterRuleContracts.RefuseShape(filters) is { } shape)
        {
            refusal = shape;
            return null;
        }

        if (sort is not null && sort.Property is null)
        {
            refusal = "a sort needs a property";
            return null;
        }

        if (groupBy is not null && groupBy.Property is null)
        {
            refusal = "a grouping needs a property";
            return null;
        }

        if (groupBy?.Order is { } order && order.Any(key => key is null))
        {
            refusal = "a group order lists group keys, none of them null";
            return null;
        }

        refusal = null;
        return new WorkspaceQueryInput(
            WorkspaceId.From(workspaceId),
            scope?.ParentId is { } parent ? ItemId.From(parent) : null,
            scope?.Descendants ?? true,
            preset,
            FilterRuleContracts.ToDomain(filters),
            sort?.Property,
            sort?.Descending ?? false,
            groupBy?.Property,
            groupBy?.Order is { } keys ? [.. keys] : ImmutableArray<string>.Empty,
            today);
    }
}

/// <summary>Route handler for the ad-hoc workspace query.</summary>
internal static class RunWorkspaceQueryEndpoint
{
    /// <summary>Handles a request to run an ad-hoc query.</summary>
    /// <param name="workspaceId">The workspace to query.</param>
    /// <param name="request">The query.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The matches, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<WorkspaceQueryResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        [FromBody] WorkspaceQueryRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);

        var input = WorkspaceQueryRequests.ToInput(
            workspaceId, request.Scope, request.Preset, request.Filters, request.Sort, request.GroupBy, request.Today, out var refusal);
        if (input is null)
        {
            return TypedResults.Problem(QueryEndpoints.Problem(httpContext, QueryErrors.InvalidRequest(refusal!)));
        }

        var result = await dispatcher
            .QueryAsync<RunWorkspaceQuery, Result<WorkspaceQueryResults>>(
                new RunWorkspaceQuery(input, request.Limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<WorkspaceQueryResponse>, ProblemHttpResult>>(
            run => TypedResults.Ok(QueryMapping.ToResponse(workspaceId, run)),
            error => TypedResults.Problem(QueryEndpoints.Problem(httpContext, error)));
    }
}

/// <summary>Route handler for the ad-hoc workspace aggregate.</summary>
internal static class AggregateWorkspaceQueryEndpoint
{
    /// <summary>Handles a request to fold an ad-hoc query.</summary>
    /// <param name="workspaceId">The workspace to query.</param>
    /// <param name="request">The query and its fold.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The groups and totals, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<WorkspaceAggregateResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        [FromBody] WorkspaceAggregateRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.Aggregate?.Function is not { } function)
        {
            return TypedResults.Problem(QueryEndpoints.Problem(
                httpContext,
                QueryErrors.InvalidRequest("name the aggregate: {\"aggregate\": {\"function\": \"count\"}}")));
        }

        var input = WorkspaceQueryRequests.ToInput(
            workspaceId, request.Scope, request.Preset, request.Filters, sort: null, request.GroupBy, request.Today, out var refusal);
        if (input is null)
        {
            return TypedResults.Problem(QueryEndpoints.Problem(httpContext, QueryErrors.InvalidRequest(refusal!)));
        }

        var result = await dispatcher
            .QueryAsync<AggregateWorkspaceQuery, Result<WorkspaceAggregateResults>>(
                new AggregateWorkspaceQuery(input, function, request.Aggregate.Property),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<WorkspaceAggregateResponse>, ProblemHttpResult>>(
            run => TypedResults.Ok(QueryMapping.ToResponse(workspaceId, run)),
            error => TypedResults.Problem(QueryEndpoints.Problem(httpContext, error)));
    }
}
