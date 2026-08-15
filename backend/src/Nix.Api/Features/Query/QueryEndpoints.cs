using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.Query;

/// <summary>
/// Route registration for the query feature: a saved cross-container query, run server-side.
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
                + "list can say where a row lives.");

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
            ViewNotFoundCode => StatusCodes.Status404NotFound,
            InvalidTodayCode => StatusCodes.Status400BadRequest,
            InvalidRulesCode => StatusCodes.Status422UnprocessableEntity,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    /// <summary>The ceiling as the published description spells it.</summary>
    /// <remarks>Read off the handler rather than typed, so raising it cannot leave prose stale.</remarks>
    private static string Ceiling =>
        RunItemQueryHandler.MaximumResults.ToString("N0", CultureInfo.InvariantCulture);
}
