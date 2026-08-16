using System.Collections.Immutable;
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
            view.Filters.IsDefaultOrEmpty
                ? []
                : [.. view.Filters.Select(rule => new FilterRuleContract(rule.Property, rule.Operator, rule.Value))],
            view.CompanionViewId,
            view.CompanionPlacement,
            ToContract(view.InteractiveForm));
    }

    /// <summary>
    /// Reads a requested view set, or says which kind it did not recognise.
    /// </summary>
    /// <param name="request">The request.</param>
    /// <param name="views">The views, when every kind was recognised.</param>
    /// <param name="unknownKind">The first unrecognised kind, when one was met.</param>
    /// <returns><see langword="true"/> when the request maps cleanly.</returns>
    internal static bool TryToDomain(
        SetViewsRequest request,
        out ImmutableArray<ViewDefinition> views,
        out string? unknownKind)
    {
        ArgumentNullException.ThrowIfNull(request);

        var mapped = ImmutableArray.CreateBuilder<ViewDefinition>(request.Views.Count);

        foreach (var view in request.Views)
        {
            if (!ViewKinds.TryParse(view.Kind, out var kind))
            {
                views = [];
                unknownKind = view.Kind;
                return false;
            }

            mapped.Add(
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
                    view.Filters is null
                        ? []
                        : [.. view.Filters.Select(rule => new FilterRule(rule.Property, rule.Operator, rule.Value))],
                    view.CompanionViewId,
                    view.CompanionPlacement,
                    ToDomain(view.InteractiveForm)));
        }

        views = mapped.ToImmutable();
        unknownKind = null;
        return true;
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
