using System.Collections.Immutable;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Templates;

public sealed class TemplateValidationTests
{
    [Fact]
    public void Schema_rules_reject_selects_without_options()
    {
        var schema = new PropertySchema
        {
            Inherit = true,
            Properties = [new PropertyDefinition("status", "Status", PropertyType.Select, [], false)],
        };

        Assert.Contains("at least one option", PropertySchemaRules.Refuse(schema), StringComparison.Ordinal);
    }

    [Fact]
    public void Schema_rules_reject_options_on_text_fields()
    {
        var schema = new PropertySchema
        {
            Inherit = true,
            Properties = [new PropertyDefinition("owner", "Owner", PropertyType.Text, ["A"], false)],
        };

        Assert.Contains("cannot carry options", PropertySchemaRules.Refuse(schema), StringComparison.Ordinal);
    }

    [Fact]
    public void View_rules_reject_a_default_that_does_not_exist()
    {
        var views = ImmutableArray.Create(
            new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false));

        Assert.Contains("cannot be the one that opens", ViewDefinitionRules.Refuse(views, "missing"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void View_rules_reject_conditions_that_reference_a_later_field()
    {
        var form = new InteractiveFormDefinition(
            [new FormPage(
                "page",
                "Page",
                null,
                [],
                [
                    new FormBlock(
                        "conditional",
                        "field",
                        "answer",
                        "Answer",
                        null,
                        false,
                        null,
                        [new FormCondition("later", "equals", "yes")]),
                    new FormBlock("later", "field", "later", "Later", null, false, null, []),
                ])],
            "generated",
            null,
            "Thanks",
            "Saved");
        var views = ImmutableArray.Create(
            new ViewDefinition(
                "form",
                "Form",
                ViewKind.InteractiveForm,
                [],
                null,
                [],
                null,
                null,
                false,
                InteractiveForm: form));

        Assert.Contains("earlier field", ViewDefinitionRules.Refuse(views, "form"), StringComparison.Ordinal);
    }

    // The Recipes-as-a-template bug: a working container's view listed a column its schema no
    // longer declared. The live product renders that column as nothing (ViewDefinition.CanRender
    // ignores columns), so capturing the container as a template must accept it too. Import stays
    // strict, because its content is external.
    [Fact]
    public void A_view_column_the_schema_does_not_declare_is_rejected_when_strict()
    {
        var reason = new TemplateDefinitionValidator()
            .ValidateViewDependencies(PropertySchema.Empty, CompanionWithDanglingColumn());

        Assert.NotNull(reason);
        Assert.Contains("does not declare", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_view_column_the_schema_does_not_declare_is_tolerated_when_capturing()
    {
        var reason = new TemplateDefinitionValidator()
            .ValidateViewDependencies(PropertySchema.Empty, CompanionWithDanglingColumn(), tolerateDrift: true);

        Assert.Null(reason);
    }

    private static StoredViews CompanionWithDanglingColumn() =>
        new(
            [
                new ViewDefinition(
                    "companion",
                    "Companion",
                    ViewKind.List,
                    ["ingredient"],
                    null,
                    [],
                    null,
                    null,
                    false),
            ],
            null);
}
