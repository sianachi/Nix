using System.Collections.Immutable;
using Nix.Domain.Properties;
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
}
