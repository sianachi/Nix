using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>Pure storage rules shared by every view-writing boundary.</summary>
public static class ViewDefinitionRules
{
    /// <summary>The most filter rules one view may carry.</summary>
    public const int MaximumFilters = 8;

    /// <summary>Returns the first reason a complete view set cannot be stored, or null.</summary>
    public static string? Refuse(ImmutableArray<ViewDefinition> views, string? defaultView)
    {
        if (views.Length > ViewDefinitionsJson.MaximumViews)
        {
            return $"A container may offer at most {ViewDefinitionsJson.MaximumViews} views.";
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var view in views)
        {
            if (view.Id.Length == 0)
            {
                return "Every view needs an identifier.";
            }

            if (!ids.Add(view.Id))
            {
                return $"'{view.Id}' is used by more than one view; a shared link names one view.";
            }

            if (view.Name.Length == 0)
            {
                return "Every view needs a name.";
            }

            if (string.Equals(view.Id, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal))
            {
                return $"'{ViewDefinitionsJson.DocumentView}' is reserved for the item's own body; "
                    + "give this view another name.";
            }

            if (ViewKinds.Find(view.Kind)?.Requirement is { } requirement
                && requirement.Read(view) is null)
            {
                return $"'{view.Name}': {requirement.Missing}.";
            }

            if (view.Measure is { } measure && !ChartMeasures.IsValid(measure))
            {
                return $"'{view.Name}': '{measure}' is not a measure a chart can draw; "
                    + $"use '{ChartMeasures.Count}' or '{ChartMeasures.Sum}'.";
            }

            if (view.Kind == ViewKind.Chart
                && string.Equals(view.Measure, ChartMeasures.Sum, StringComparison.Ordinal)
                && string.IsNullOrEmpty(view.MeasureProperty))
            {
                // A total with nothing to total draws every bar at zero, which looks like data.
                return $"'{view.Name}' totals a property, so it needs one to total.";
            }

            if (view.CardSize is { } size && !GalleryCardSizes.IsValid(size))
            {
                return $"'{view.Name}': '{size}' is not a card size; "
                    + $"use '{GalleryCardSizes.Small}', '{GalleryCardSizes.Medium}' or '{GalleryCardSizes.Large}'.";
            }

            if (!view.Filters.IsDefaultOrEmpty)
            {
                if (view.Filters.Length > MaximumFilters)
                {
                    return $"'{view.Name}': a view may carry at most {MaximumFilters} filters.";
                }

                foreach (var rule in view.Filters)
                {
                    if (QueryOperators.Refuse(rule) is { } reason)
                    {
                        return $"'{view.Name}': {reason}.";
                    }
                }
            }
        }

        foreach (var view in views)
        {
            if (view.CompanionViewId is { } companion)
            {
                if (!ids.Contains(companion) || string.Equals(companion, view.Id, StringComparison.Ordinal))
                {
                    return $"'{view.Name}': its companion must name another view in this item.";
                }

                if (view.CompanionPlacement is not ("below" or "beside"))
                {
                    return $"'{view.Name}': a companion must be placed 'below' or 'beside'.";
                }

                var target = views.First(candidate => string.Equals(candidate.Id, companion, StringComparison.Ordinal));
                if (target.CompanionViewId is not null)
                {
                    return $"'{view.Name}': companion views cannot contain another companion.";
                }
            }
            else if (view.CompanionPlacement is not null)
            {
                return $"'{view.Name}': companion placement needs a companion view.";
            }

            if (view.Kind == ViewKind.InteractiveForm && RefuseForm(view.InteractiveForm) is { } formReason)
            {
                return $"'{view.Name}': {formReason}.";
            }
        }

        if (defaultView is { } chosen
            && chosen.Length > 0
            && !string.Equals(chosen, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
            && !ids.Contains(chosen))
        {
            return $"'{chosen}' is not one of these views, so it cannot be the one that opens.";
        }

        return null;
    }

    private static string? RefuseForm(InteractiveFormDefinition? form)
    {
        if (form is null || form.Pages.IsDefaultOrEmpty)
        {
            return "an interactive form needs at least one page";
        }

        if (form.TitleMode is not ("generated" or "field"))
        {
            return "the response title must be generated or taken from a field";
        }

        var blockIds = new HashSet<string>(StringComparer.Ordinal);
        var fieldIds = new HashSet<string>(StringComparer.Ordinal);
        var earlierFields = new HashSet<string>(StringComparer.Ordinal);
        var pageIds = new HashSet<string>(StringComparer.Ordinal);
        var identityRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (var page in form.Pages)
        {
            if (page.Id.Length == 0 || !pageIds.Add(page.Id) || page.Blocks.IsDefaultOrEmpty)
            {
                return "every page needs a unique identifier and at least one block";
            }

            if (RefuseCondition(page.VisibleWhen, earlierFields) is { } pageCondition)
            {
                return $"page '{page.Id}' {pageCondition}";
            }

            foreach (var block in page.Blocks)
            {
                if (block.Id.Length == 0 || !blockIds.Add(block.Id))
                {
                    return "every form block needs a unique identifier";
                }

                if (block.Kind == "field" && string.IsNullOrWhiteSpace(block.PropertyKey))
                {
                    return $"field '{block.Id}' needs a property";
                }

                if (block.Kind is not ("field" or "heading" or "paragraph"))
                {
                    return $"'{block.Kind}' is not a form block kind";
                }

                if (RefuseCondition(block.VisibleWhen, earlierFields) is { } blockCondition)
                {
                    return $"block '{block.Id}' {blockCondition}";
                }

                if (block.IdentityRole is { } identityRole)
                {
                    if (block.Kind != "field" || identityRole is not ("name" or "email"))
                    {
                        return $"block '{block.Id}' has an invalid respondent identity role";
                    }

                    if (!identityRoles.Add(identityRole))
                    {
                        return $"respondent {identityRole} may be assigned to only one field";
                    }
                }

                if (block.Kind == "field")
                {
                    fieldIds.Add(block.Id);
                    earlierFields.Add(block.Id);
                }
            }
        }

        if (form.TitleMode == "field"
            && (form.TitleFieldBlockId is null || !fieldIds.Contains(form.TitleFieldBlockId)))
        {
            return "the response-title field must name a field block";
        }

        return null;
    }

    private static string? RefuseCondition(
        ImmutableArray<FormCondition> conditions,
        HashSet<string> earlierFields)
    {
        if (conditions.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var condition in conditions)
        {
            if (!earlierFields.Contains(condition.FieldBlockId))
            {
                return "has a condition that does not reference an earlier field";
            }

            if (condition.Operator is not ("equals" or "not_equals" or "contains" or "checked" or "not_checked"))
            {
                return $"uses unknown condition operator '{condition.Operator}'";
            }
        }

        return null;
    }
}
