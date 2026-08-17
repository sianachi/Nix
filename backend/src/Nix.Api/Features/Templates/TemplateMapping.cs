using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Views;

namespace Nix.Features.Templates;

internal static class TemplateMapping
{
    internal static TemplateSummaryResponse Summary(TemplateCatalogSnapshot snapshot)
    {
        var template = snapshot.Template;
        var editable = snapshot.CanManage && template.Origin == TemplateOrigin.User;
        return new TemplateSummaryResponse(
            template.Id.Value,
            template.WorkspaceId.Value,
            template.Title,
            template.Description,
            Origin(template.Origin),
            template.Revision,
            template.IncludeBody,
            template.IncludeChildren,
            snapshot.Shape.FieldCount,
            snapshot.Shape.ViewCount,
            snapshot.Shape.ChildCount,
            snapshot.Shape.ViewKinds,
            new TemplateCapabilitiesResponse(editable, editable, true, snapshot.CanManage),
            template.LastModifiedAt);
    }

    internal static TemplateDetailResponse Detail(TemplateDetailSnapshot snapshot)
    {
        var summary = Summary(new TemplateCatalogSnapshot(snapshot.Template, snapshot.Shape, snapshot.CanManage));
        return new TemplateDetailResponse(
            summary.Id,
            summary.WorkspaceId,
            summary.Title,
            summary.Description,
            summary.Origin,
            summary.Revision,
            summary.IncludeBody,
            summary.IncludeChildren,
            summary.FieldCount,
            summary.ViewCount,
            summary.ChildCount,
            summary.ViewKinds,
            summary.Capabilities,
            summary.UpdatedAt,
            Item(snapshot.Root));
    }

    internal static TemplateItemResponse Item(TemplateItemSnapshot item) =>
        Item(item, PropertySchema.Empty);

    private static TemplateItemResponse Item(TemplateItemSnapshot item, PropertySchema inherited)
    {
        var hasDeclaredSchema = !string.IsNullOrWhiteSpace(item.Schema);
        var declared = PropertySchemaJson.Read(item.Schema);
        var effective = declared.Inherit ? PropertySchema.Merge(inherited, declared) : declared;
        var schema = !hasDeclaredSchema && inherited.IsEmpty
            ? null
            : new TemplatePropertySchemaResponse(
                effective.Properties.Select(Property).ToArray(),
                hasDeclaredSchema ? declared.Properties.Select(Property).ToArray() : [],
                declared.Inherit);

        return new TemplateItemResponse(
            item.SourceId,
            item.ItemType,
            item.Title,
            item.Seq.ToString(System.Globalization.CultureInfo.InvariantCulture),
            Object(item.Properties),
            schema,
            Views(item.Views),
            item.HasBody,
            item.Children.Select(child => Item(child, effective)).ToArray());
    }

    private static TemplatePropertyDefinitionResponse Property(PropertyDefinition property) =>
        new(
            property.Key,
            property.Label,
            PropertyTypes.ToText(property.Type),
            property.Options,
            property.Required);

    private static TemplateStoredViewsResponse? Views(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        var stored = ViewDefinitionsJson.Read(json);
        return new TemplateStoredViewsResponse(
            stored.Views.Select(View).ToArray(),
            stored.Default);
    }

    private static TemplateViewResponse View(ViewDefinition view) =>
        new(
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
                : view.Filters.Select(filter => new TemplateFilterResponse(
                    filter.Property,
                    filter.Operator,
                    filter.Value)).ToArray(),
            view.CompanionViewId,
            view.CompanionPlacement,
            InteractiveForm(view.InteractiveForm));

    private static TemplateInteractiveFormResponse? InteractiveForm(InteractiveFormDefinition? form) =>
        form is null
            ? null
            : new TemplateInteractiveFormResponse(
                form.Pages.Select(page => new TemplateFormPageResponse(
                    page.Id,
                    page.Title,
                    page.Description,
                    page.VisibleWhen.Select(Condition).ToArray(),
                    page.Blocks.Select(block => new TemplateFormBlockResponse(
                        block.Id,
                        block.Kind,
                        block.PropertyKey,
                        block.Text,
                        block.Help,
                        block.Required,
                        block.IdentityRole,
                        block.VisibleWhen.Select(Condition).ToArray())).ToArray())).ToArray(),
                form.TitleMode,
                form.TitleFieldBlockId,
                form.ConfirmationTitle,
                form.ConfirmationMessage);

    private static TemplateFormConditionResponse Condition(FormCondition condition) =>
        new(condition.FieldBlockId, condition.Operator, condition.Value);

    internal static TemplateOriginResponse Origin(TemplateOrigin origin) => origin switch
    {
        TemplateOrigin.Seed => TemplateOriginResponse.Seed,
        TemplateOrigin.User => TemplateOriginResponse.User,
        TemplateOrigin.Managed => TemplateOriginResponse.Managed,
        _ => throw new ArgumentOutOfRangeException(nameof(origin), origin, "Unknown template origin."),
    };

    internal static JsonObject? Object(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
