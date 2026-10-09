using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using Nix.Domain.Views;

namespace Nix.Features.Views;

/// <summary>Maps between the view contract and the domain.</summary>
internal static class ViewMapping
{
    /// <summary>Maps one view onto the published shape.</summary>
    /// <param name="view">The domain view.</param>
    /// <returns>The published shape.</returns>
    internal static ViewResponse ToResponse(ViewDefinition view)
    {
        ArgumentNullException.ThrowIfNull(view);

        return new ViewResponse(
            view.Id,
            view.Name,
            ViewKinds.ToText(view.Kind),
            view.Columns,
            view.GroupBy,
            view.GroupOrder,
            view.DateProperty,
            view.SortBy,
            view.SortDescending,
            view.Mode,
            view.CoverProperty,
            view.EndDateProperty,
            view.CardSize,
            FilterRuleContracts.ToContract(view.Filters),
            view.CompanionViewId,
            view.CompanionPlacement,
            ToContract(view.InteractiveForm),
            view.Measure,
            view.MeasureProperty,
            view.Sorts.IsDefaultOrEmpty
                ? []
                : [.. view.Sorts.Select(sort => new ViewSortContract(sort.Property, sort.Descending))],
            view.CollapsedGroups.IsDefaultOrEmpty ? [] : view.CollapsedGroups,
            view.GroupLimits.IsDefaultOrEmpty
                ? []
                : [.. view.GroupLimits.Select(limit => new ViewGroupLimitContract(limit.Group, limit.Limit))],
            view.Aggregates.IsDefaultOrEmpty
                ? []
                : [.. view.Aggregates.Select(aggregate => new ViewAggregateContract(aggregate.Property, aggregate.Function))],
            view.HabitWidgets.IsDefaultOrEmpty ? [] : [.. view.HabitWidgets.Select(widget => new HabitWidgetContract(widget.Id, widget.Kind, widget.HabitId, widget.From, widget.To))],
            view.Layout,
            view.DoneProperty,
            view.RowBy,
            ToContract(view.Chart));
    }

    /// <summary>
    /// Reads a requested view set, or says why it cannot be read.
    /// </summary>
    /// <param name="request">The request.</param>
    /// <param name="views">The views, when the request maps cleanly.</param>
    /// <param name="refusal">
    /// Why it does not, when it does not: an unrecognised kind, or a null where a sort, group
    /// limit, summary or filter entry - or one of its strings - must be. Worded for the problem
    /// detail of <c>views.invalid</c>.
    /// </param>
    /// <returns><see langword="true"/> when the request maps cleanly.</returns>
    /// <remarks>
    /// The contract's strings are non-nullable, but the serializer does not enforce that, so a
    /// hand-written client's null reaches here. It is refused before anything dereferences it,
    /// which is what keeps it a 422 rather than a 500.
    /// </remarks>
    internal static bool TryToDomain(
        SetViewsRequest request,
        out ImmutableArray<ViewDefinition> views,
        [NotNullWhen(false)] out string? refusal)
    {
        ArgumentNullException.ThrowIfNull(request);

        var mapped = ImmutableArray.CreateBuilder<ViewDefinition>(request.Views.Count);

        foreach (var view in request.Views)
        {
            if (view is null)
            {
                views = [];
                refusal = "A view cannot be null.";
                return false;
            }

            if (!ViewKinds.TryParse(view.Kind, out var kind))
            {
                views = [];
                refusal = $"'{view.Kind}' is not a view kind.";
                return false;
            }

            if (RefuseNulls(view) is { } nulls)
            {
                views = [];
                refusal = $"'{view.Name}': {nulls}.";
                return false;
            }

            mapped.Add(ViewSorting.MirrorPrimary(
                new ViewDefinition(
                    view.Id,
                    view.Name,
                    kind,
                    view.Columns is null ? [] : [.. view.Columns],
                    view.GroupBy,
                    view.GroupOrder is null ? [] : [.. view.GroupOrder],
                    view.DateProperty,
                    view.SortBy,
                    view.SortDescending,
                    view.Mode,
                    view.CoverProperty,
                    view.EndDateProperty,
                    view.CardSize,
                    FilterRuleContracts.ToDomain(view.Filters),
                    view.CompanionViewId,
                    view.CompanionPlacement,
                    ToDomain(view.InteractiveForm),
                    view.Measure,
                    view.MeasureProperty,
                    view.HabitWidgets is null ? [] : [.. view.HabitWidgets.Select(widget => new HabitWidgetDefinition(widget.Id, widget.Kind, widget.HabitId, widget.From, widget.To))],
                    view.Layout,
                    view.Sorts is null
                        ? []
                        : [.. view.Sorts.Select(sort => new ViewSort(sort.Property, sort.Descending))],
                    view.CollapsedGroups is null ? [] : [.. view.CollapsedGroups],
                    view.GroupLimits is null
                        ? []
                        : [.. view.GroupLimits.Select(limit => new ViewGroupLimit(limit.Group, limit.Limit))],
                    view.Aggregates is null
                        ? []
                        : [.. view.Aggregates.Select(aggregate => new ViewAggregate(aggregate.Property, aggregate.Function))],
                    view.DoneProperty,
                    view.RowBy,
                    ToDomain(view.Chart))));
        }

        views = mapped.ToImmutable();
        refusal = null;
        return true;
    }

    private static string? RefuseNulls(ViewRequest view)
    {
        if (view.Sorts is not null && view.Sorts.Any(sort => sort?.Property is null))
        {
            return "every sort needs a property key";
        }

        if (view.GroupLimits is not null && view.GroupLimits.Any(limit => limit?.Group is null))
        {
            return "every group limit needs a group value, empty for the \"no value\" group";
        }

        if (view.Aggregates is not null
            && view.Aggregates.Any(aggregate => aggregate?.Property is null || aggregate.Function is null))
        {
            return "every summary needs a property key and a function";
        }

        if (FilterRuleContracts.RefuseShape(view.Filters) is { } filterShape)
        {
            return filterShape;
        }

        return null;
    }

    private static ChartOptionsContract? ToContract(ChartOptions? chart) =>
        chart is null
            ? null
            : new ChartOptionsContract(
                chart.Kind,
                chart.Period,
                chart.SplitBy,
                chart.LastPeriods,
                chart.From,
                chart.To,
                chart.Cumulative,
                chart.RollingAverage,
                chart.Stacked);

    /// <summary>Reads requested chart options; an all-default object stores as none.</summary>
    private static ChartOptions? ToDomain(ChartOptionsContract? chart)
    {
        if (chart is null)
        {
            return null;
        }

        var options = new ChartOptions(
            chart.Kind,
            chart.Period,
            chart.SplitBy,
            chart.LastPeriods,
            chart.From,
            chart.To,
            chart.Cumulative ?? false,
            chart.RollingAverage ?? false,
            chart.Stacked ?? false);

        return options.IsEmpty ? null : options;
    }

    private static InteractiveFormContract? ToContract(InteractiveFormDefinition? form) =>
        form is null
            ? null
            : new InteractiveFormContract(
                [.. form.Pages.Select(page => new FormPageContract(
                    page.Id,
                    page.Title,
                    page.Description,
                    [.. page.VisibleWhen.Select(ToContract)],
                    [.. page.Blocks.Select(block => new FormBlockContract(
                        block.Id,
                        block.Kind,
                        block.PropertyKey,
                        block.Text,
                        block.Help,
                        block.Required,
                        block.IdentityRole,
                        [.. block.VisibleWhen.Select(ToContract)]))]))],
                form.TitleMode,
                form.TitleFieldBlockId,
                form.ConfirmationTitle,
                form.ConfirmationMessage);

    private static FormConditionContract ToContract(FormCondition condition) =>
        new(condition.FieldBlockId, condition.Operator, condition.Value);

    private static InteractiveFormDefinition? ToDomain(InteractiveFormContract? form) =>
        form is null
            ? null
            : new InteractiveFormDefinition(
                [.. form.Pages.Select(page => new FormPage(
                    page.Id,
                    page.Title,
                    page.Description,
                    [.. page.VisibleWhen.Select(ToDomain)],
                    [.. page.Blocks.Select(block => new FormBlock(
                        block.Id,
                        block.Kind,
                        block.PropertyKey,
                        block.Text,
                        block.Help,
                        block.Required,
                        block.IdentityRole,
                        [.. block.VisibleWhen.Select(ToDomain)]))]))],
                form.TitleMode,
                form.TitleFieldBlockId,
                form.ConfirmationTitle,
                form.ConfirmationMessage);

    private static FormCondition ToDomain(FormConditionContract condition) =>
        new(condition.FieldBlockId, condition.Operator, condition.Value);
}
