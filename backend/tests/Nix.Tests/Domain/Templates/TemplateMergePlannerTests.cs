using Nix.Domain.Properties;
using Nix.Domain.Templates;

namespace Nix.Tests.Domain.Templates;

public sealed class TemplateMergePlannerTests
{
    [Fact]
    public void Matching_formula_definitions_preserve_the_target_label_and_inheritance()
    {
        var existing = Schema(new PropertyDefinition("total", "Existing total", PropertyType.Formula, [], false, "[amount] * 2"));
        var incoming = Schema(new PropertyDefinition("total", "Template total", PropertyType.Formula, [], false, "[amount] * 2"), inherit: true);

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(existing, incoming, null, null);

        Assert.Empty(plan.Conflicts);
        Assert.Equal(0, plan.FieldAdditions);
        Assert.Equal(existing, plan.Schema);
    }

    [Theory]
    [InlineData("[amount] * 2", "[amount] * 3")]
    [InlineData("[amount] * 2", "[Amount] * 2")]
    public void Different_formula_expressions_conflict_without_replacing_the_target(string existingExpression, string incomingExpression)
    {
        var existing = Schema(new PropertyDefinition("total", "Total", PropertyType.Formula, [], false, existingExpression));
        var incoming = Schema(new PropertyDefinition("total", "Total", PropertyType.Formula, [], false, incomingExpression));

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(existing, incoming, null, null);

        Assert.Equal("Property 'total' already exists with an incompatible definition.", Assert.Single(plan.Conflicts));
        Assert.Equal(0, plan.FieldAdditions);
        Assert.Equal(existing, plan.Schema);
    }

    [Theory]
    [InlineData(RollupAggregate.Sum, "amount")]
    [InlineData(RollupAggregate.Count, null)]
    public void Matching_rollup_definitions_remain_compatible(RollupAggregate aggregate, string? source)
    {
        var existing = Schema(new PropertyDefinition("total", "Total", PropertyType.Rollup, [], false, Aggregate: aggregate, Source: source));

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(existing, existing, null, null);

        Assert.Empty(plan.Conflicts);
        Assert.Equal(0, plan.FieldAdditions);
        Assert.Equal(existing, plan.Schema);
    }

    [Theory]
    [InlineData(RollupAggregate.Sum, "amount", RollupAggregate.Average, "amount")]
    [InlineData(RollupAggregate.Sum, "amount", RollupAggregate.Sum, "budget")]
    [InlineData(RollupAggregate.Count, null, RollupAggregate.Count, "amount")]
    [InlineData(RollupAggregate.Count, "amount", RollupAggregate.Count, null)]
    [InlineData(RollupAggregate.Sum, "amount", RollupAggregate.Sum, "Amount")]
    public void Different_rollup_definitions_conflict_without_replacing_the_target(
        RollupAggregate existingAggregate,
        string? existingSource,
        RollupAggregate incomingAggregate,
        string? incomingSource)
    {
        var existing = Schema(new PropertyDefinition("total", "Total", PropertyType.Rollup, [], false, Aggregate: existingAggregate, Source: existingSource));
        var incoming = Schema(new PropertyDefinition("total", "Total", PropertyType.Rollup, [], false, Aggregate: incomingAggregate, Source: incomingSource));

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(existing, incoming, null, null);

        Assert.Equal("Property 'total' already exists with an incompatible definition.", Assert.Single(plan.Conflicts));
        Assert.Equal(0, plan.FieldAdditions);
        Assert.Equal(existing, plan.Schema);
    }

    [Fact]
    public void New_formula_and_rollup_fields_are_added_with_their_computed_definitions()
    {
        var incoming = PropertySchemaJson.Write(new PropertySchema
        {
            Inherit = true,
            Properties =
            [
                new PropertyDefinition("total", "Total", PropertyType.Formula, [], false, "[amount] * 2"),
                new PropertyDefinition("children", "Children", PropertyType.Rollup, [], false, Aggregate: RollupAggregate.Count),
            ],
        });

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(null, incoming, null, null);

        Assert.Empty(plan.Conflicts);
        Assert.Equal(2, plan.FieldAdditions);
        Assert.Equal(incoming, plan.Schema);
    }

    [Fact]
    public void A_new_local_formula_can_override_an_inherited_formula()
    {
        var inherited = new PropertySchema
        {
            Inherit = true,
            Properties = [new PropertyDefinition("total", "Inherited total", PropertyType.Formula, [], false, "[amount] * 2")],
        };
        var incoming = Schema(new PropertyDefinition("total", "Local total", PropertyType.Formula, [], false, "[amount] * 3"), inherit: true);

        var plan = new TemplateMergePlanner(new TemplateDefinitionValidator()).Plan(null, incoming, null, null, inherited);

        Assert.Empty(plan.Conflicts);
        Assert.Equal(1, plan.FieldAdditions);
        Assert.Equal(incoming, plan.Schema);
    }

    private static string Schema(PropertyDefinition property, bool inherit = false) =>
        PropertySchemaJson.Write(new PropertySchema { Inherit = inherit, Properties = [property] });
}
