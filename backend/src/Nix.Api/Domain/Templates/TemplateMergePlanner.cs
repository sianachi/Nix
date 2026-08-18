using System.Collections.Immutable;
using System.Text;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Domain.Templates;

/// <summary>The lossless result of planning one root-envelope merge.</summary>
public sealed record TemplateMergePlan(
    string? Schema,
    string? Views,
    int FieldAdditions,
    int ViewAdditions,
    IReadOnlyList<string> Conflicts);

/// <summary>Plans compatible schema and view additions without performing I/O.</summary>
public sealed class TemplateMergePlanner(TemplateDefinitionValidator validator)
{
    private readonly TemplateDefinitionValidator _validator = validator
        ?? throw new ArgumentNullException(nameof(validator));

    public TemplateMergePlan Plan(
        string? existingSchema,
        string? incomingSchema,
        string? existingViews,
        string? incomingViews,
        PropertySchema? effectiveExistingSchema = null)
    {
        var conflicts = new List<string>();
        var currentSchema = PropertySchemaJson.Read(existingSchema);
        var templateSchema = PropertySchemaJson.Read(incomingSchema);
        var properties = currentSchema.Properties.ToBuilder();
        var propertyByKey = currentSchema.Properties.ToDictionary(property => property.Key, StringComparer.Ordinal);
        var fieldAdditions = 0;
        foreach (var incoming in templateSchema.Properties)
        {
            if (!propertyByKey.TryGetValue(incoming.Key, out var existing))
            {
                properties.Add(incoming);
                propertyByKey[incoming.Key] = incoming;
                fieldAdditions++;
                continue;
            }

            if (existing.Type != incoming.Type
                || existing.Required != incoming.Required
                || !existing.Options.SequenceEqual(incoming.Options, StringComparer.Ordinal))
            {
                conflicts.Add($"Property '{incoming.Key}' already exists with an incompatible definition.");
            }
        }

        var currentViews = ViewDefinitionsJson.Read(existingViews);
        var templateViews = ViewDefinitionsJson.Read(incomingViews);
        var views = currentViews.Views.ToBuilder();
        var viewById = currentViews.Views.ToDictionary(view => view.Id, StringComparer.Ordinal);
        var viewAdditions = 0;
        foreach (var incoming in templateViews.Views)
        {
            if (!viewById.TryGetValue(incoming.Id, out var existing))
            {
                views.Add(incoming);
                viewById[incoming.Id] = incoming;
                viewAdditions++;
                continue;
            }

            var existingJson = ViewDefinitionsJson.Write(ImmutableArray.Create(existing), existing.Id);
            var incomingJson = ViewDefinitionsJson.Write(ImmutableArray.Create(incoming), incoming.Id);
            if (!string.Equals(existingJson, incomingJson, StringComparison.Ordinal))
            {
                conflicts.Add($"View '{incoming.Id}' already exists with an incompatible definition.");
            }
        }

        var mergedSchemaModel = new PropertySchema
        {
            Inherit = currentSchema.Inherit,
            Properties = properties.ToImmutable(),
        };
        var mergedViewsModel = views.ToImmutable();
        if (PropertySchemaRules.Refuse(mergedSchemaModel) is { } schemaConflict)
        {
            conflicts.Add(schemaConflict);
        }

        if (ViewDefinitionRules.Refuse(mergedViewsModel, currentViews.Default) is { } viewConflict)
        {
            conflicts.Add(viewConflict);
        }

        var dependencySchema = effectiveExistingSchema ?? currentSchema;
        dependencySchema = PropertySchema.Merge(
            dependencySchema,
            templateSchema with { Inherit = dependencySchema.Inherit });
        // The merge planner only ever runs on the apply lifecycle, over a template captured from a
        // workspace. It tolerates a view whose column the merged schema does not declare, the same
        // way capture did and the live container does - otherwise a template that saved could not
        // be applied. Import never reaches here.
        if (_validator.ValidateViewDependencies(
                dependencySchema,
                new StoredViews(mergedViewsModel, currentViews.Default),
                tolerateDrift: true) is { } dependencyConflict)
        {
            conflicts.Add(dependencyConflict);
        }

        var mergedSchema = PropertySchemaJson.Write(mergedSchemaModel);
        var mergedViews = ViewDefinitionsJson.Write(mergedViewsModel, currentViews.Default);
        if (Encoding.UTF8.GetByteCount(mergedSchema) > PropertyValidator.MaximumBytes)
        {
            conflicts.Add($"The merged property schema would exceed {PropertyValidator.MaximumBytes} bytes.");
        }

        if (mergedViews is not null
            && Encoding.UTF8.GetByteCount(mergedViews) > ViewDefinitionsJson.MaximumBytes)
        {
            conflicts.Add($"The merged view set would exceed {ViewDefinitionsJson.MaximumBytes} bytes.");
        }

        return new TemplateMergePlan(
            mergedSchema,
            mergedViews,
            fieldAdditions,
            viewAdditions,
            conflicts);
    }

}
