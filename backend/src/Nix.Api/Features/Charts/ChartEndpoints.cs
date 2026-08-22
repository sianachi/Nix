using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.Charts;

/// <summary>
/// Route registration for the chart feature: a container's children, summarised server-side.
/// </summary>
/// <remarks>
/// Registered under <c>/api/v1</c>, which is what authenticates it - the path is the policy. Its
/// own feature rather than a shape on the views routes, the argument <c>QueryEndpoints</c> makes:
/// reading a container's views answers "how may this be looked at", and this answers "what is in
/// it", which is an aggregate over every child with its own ceiling and its own honesty fields.
/// </remarks>
internal static class ChartEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    /// <remarks>
    /// The same literal the items feature publishes - asking to draw an item's chart is asking for
    /// the item. Spelled out rather than referenced, the precedent every feature here follows.
    /// </remarks>
    internal const string ItemNotFoundCode = "items.not_found";

    /// <summary>Stable code for "this item has no such chart view".</summary>
    internal const string ViewNotFoundCode = "chart.view_not_found";

    /// <summary>Stable code for a stored chart that cannot be drawn as configured.</summary>
    internal const string NotConfiguredCode = "chart.not_configured";

    /// <summary>Registers the chart feature's routes on <paramref name="endpoints"/>.</summary>
    /// <param name="endpoints">The application's route table.</param>
    /// <returns><paramref name="endpoints"/>, for chaining.</returns>
    internal static IEndpointRouteBuilder MapChartEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Charts");

        items.MapGet("/{itemId:guid}/chart", RunItemChartEndpoint.Handle)
            .WithName("RunItemChart")
            .WithSummary("Draw one of an item's chart views")
            .WithDescription(
                "Summarises every active child of the item into buckets, the way the named chart "
                + "view says to: grouped by the view's grouping property, counted, or totalled by "
                + "the view's measured property. The client names the view and never sends the "
                + "grouping - the stored view is the whole configuration, edited through PUT "
                + "/items/{itemId}/views like any other view. Children with no value for the "
                + "grouping property are their own bucket rather than being dropped, because "
                + "unset is a real and often large group and hiding it would misreport every "
                + "proportion drawn beside it. Computed over every child rather than over a page, "
                + "which is what a chart tallied in the browser could not honestly claim. At most "
                + Ceiling
                + " buckets are returned, largest first; 'truncated', 'distinctValues' and "
                + "'children' say what did not fit, so a bounded chart can say so rather than "
                + "drawing its top few as though they were all of them.");

        return endpoints;
    }

    /// <summary>Maps a chart failure onto problem details.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Total over the codes this feature can raise plus the items code it reuses, and 500 for
    /// anything else - a forgotten code must not reach clients as the one status they already
    /// handle.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            ItemNotFoundCode => StatusCodes.Status404NotFound,
            ViewNotFoundCode => StatusCodes.Status404NotFound,
            NotConfiguredCode => StatusCodes.Status422UnprocessableEntity,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    /// <summary>The ceiling as the published description spells it.</summary>
    /// <remarks>Read off the handler rather than typed, so raising it cannot leave prose stale.</remarks>
    private static string Ceiling =>
        RunItemChartHandler.MaximumBuckets.ToString("N0", CultureInfo.InvariantCulture);
}
