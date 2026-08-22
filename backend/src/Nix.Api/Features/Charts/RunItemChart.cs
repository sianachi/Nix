using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Charts;

/// <summary>What a chart view drew, over every child rather than over a loaded page.</summary>
/// <param name="GroupBy">The property the buckets are values of.</param>
/// <param name="Measure">What each bar measures.</param>
/// <param name="MeasureProperty">The property being totalled, when the measure is a total.</param>
/// <param name="Buckets">The buckets that fit, largest first.</param>
public sealed record ItemChart(
    string GroupBy,
    string Measure,
    string? MeasureProperty,
    ChildBuckets Buckets);

/// <summary>Summarises a container's children the way one of its chart views says to.</summary>
/// <param name="ItemId">The container.</param>
/// <param name="ViewId">Which of its views to draw.</param>
/// <remarks>
/// <para>
/// <b>The client names the view and never sends the grouping.</b> The stored view is the whole
/// configuration, exactly as it is for a query view (ADR-0039) and for the same reason: what a
/// chart summarises is a property of the container's configuration rather than of the request, and
/// a request that could choose would be a request that could group by anything.
/// </para>
/// <para>
/// <b>Over every child, not over the page the client holds.</b> A chart tallied in the browser from
/// the first two hundred children of three thousand would be a picture of the first page presented
/// as a picture of the whole - the dishonest state the interface rules exist to forbid. ADR-0044
/// records why the aggregate is computed where the rows are.
/// </para>
/// </remarks>
public sealed record RunItemChart(ItemId ItemId, string ViewId) : IQuery<Result<ItemChart>>;

/// <summary>Handles <see cref="RunItemChart"/>.</summary>
public sealed class RunItemChartHandler : IQueryHandler<RunItemChart, Result<ItemChart>>
{
    /// <summary>The most bars this build will draw, whatever the grouping property does.</summary>
    /// <remarks>
    /// A ceiling rather than a refusal, the posture <c>ListItemsHandler</c> takes: a grouping
    /// property that is not a declared list can take a distinct value per child, and a chart of
    /// three thousand bars is a chart nobody can read as well as a response nobody should be sent.
    /// The reader clamps to its own ceiling as well, so a caller cannot ask for more by asking
    /// twice; the response reports how many buckets there really are, so the view says it was
    /// truncated instead of drawing the top few as though they were all of them.
    /// </remarks>
    public const int MaximumBuckets = 100;

    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly IChildAggregates _aggregates;

    /// <summary>Initializes a new instance of the <see cref="RunItemChartHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    /// <param name="aggregates">Buckets the children.</param>
    public RunItemChartHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        IChildAggregates aggregates)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(aggregates);

        _tree = tree;
        _permissions = permissions;
        _aggregates = aggregates;
    }

    /// <summary>Draws the chart.</summary>
    /// <param name="query">The container and the view.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The buckets, or why they could not be read.</returns>
    public async ValueTask<Result<ItemChart>> HandleAsync(
        RunItemChart query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        // The same refusal an unreadable item gets everywhere: "you may not see this" would confirm
        // the thing exists, which is how an outsider enumerates a workspace an identifier at a time.
        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemChart>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        ViewDefinition? found = null;
        foreach (var view in ViewDefinitionsJson.Read(item.Views).Views)
        {
            if (view.Kind == ViewKind.Chart && string.Equals(view.Id, query.ViewId, StringComparison.Ordinal))
            {
                found = view;
                break;
            }
        }

        if (found is not { } chart)
        {
            return Result.Failure<ItemChart>(
                ChartErrors.ViewNotFound($"Item {itemId} has no chart view '{query.ViewId}'."));
        }

        if (string.IsNullOrEmpty(chart.GroupBy))
        {
            // A chart with nothing to group by has no bars. Refused rather than answered with an
            // empty bucket list, which a view would draw as "there is nothing in here".
            return Result.Failure<ItemChart>(
                ChartErrors.NotConfigured($"'{chart.Name}' has no property to group by."));
        }

        // Absent means count, which is what every chart stored before the field existed drew and
        // the only measure that always has an answer.
        var measure = chart.Measure is { } stored && ChartMeasures.IsValid(stored)
            ? stored
            : ChartMeasures.Count;

        var measureProperty = string.Equals(measure, ChartMeasures.Sum, StringComparison.Ordinal)
            ? chart.MeasureProperty
            : null;

        if (measure == ChartMeasures.Sum && string.IsNullOrEmpty(measureProperty))
        {
            // A total with nothing to total draws every bar at zero, which looks like data rather
            // than like a configuration nobody finished.
            return Result.Failure<ItemChart>(
                ChartErrors.NotConfigured($"'{chart.Name}' totals a property, so it needs one to total."));
        }

        var buckets = await _aggregates
            .BucketAsync(
                item.WorkspaceId,
                itemId,
                chart.GroupBy,
                measureProperty,
                MaximumBuckets,
                cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new ItemChart(chart.GroupBy, measure, measureProperty, buckets));
    }
}

/// <summary>
/// Route handler for drawing one of an item's chart views.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RunItemChart"/> itself, the same disambiguation every feature's
/// endpoint class makes.
/// </remarks>
internal static class RunItemChartEndpoint
{
    /// <summary>Handles a request to draw one of an item's chart views.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="view">Which of its views to draw.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The buckets, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<ChartResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        [FromQuery] string? view,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (string.IsNullOrEmpty(view))
        {
            return TypedResults.Problem(
                ChartEndpoints.Problem(
                    httpContext,
                    ChartErrors.ViewNotFound("Name the view to draw: ?view=<view id>.")));
        }

        var result = await dispatcher
            .QueryAsync<RunItemChart, Result<ItemChart>>(
                new RunItemChart(ItemId.From(itemId), view),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ChartResponse>, ProblemHttpResult>>(
            chart => TypedResults.Ok(
                new ChartResponse(
                    itemId,
                    view,
                    chart.GroupBy,
                    chart.Measure,
                    chart.MeasureProperty,
                    [
                        .. chart.Buckets.Buckets.Select(bucket =>
                            new ChartBucketResponse(bucket.Value, bucket.Children, bucket.Total)),
                    ],
                    chart.Buckets.Children,
                    chart.Buckets.DistinctValues,
                    chart.Buckets.DistinctValues > chart.Buckets.Buckets.Count)),
            error => TypedResults.Problem(ChartEndpoints.Problem(httpContext, error)));
    }
}
