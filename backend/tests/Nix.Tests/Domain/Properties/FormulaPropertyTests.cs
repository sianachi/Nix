using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The formula property type end to end through Core: what a schema may declare, what survives
/// storage, and what a write may do to a computed value.
/// </summary>
public sealed class FormulaPropertyTests
{
    [Fact]
    public void A_formula_property_is_stored_with_the_expression_it_declares()
    {
        var schema = SchemaOf(Formula("margin", "[price] - [cost]"));

        Assert.Null(PropertySchemaRules.Refuse(schema));

        var read = PropertySchemaJson.Read(PropertySchemaJson.Write(schema));

        Assert.Equal("[price] - [cost]", Assert.Single(read.Properties).Expression);
    }

    [Fact]
    public void A_formula_with_no_expression_is_refused()
    {
        var schema = SchemaOf(Formula("margin", string.Empty));

        Assert.Equal("'Margin' is a formula and needs an expression.", PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void A_formula_longer_than_the_engine_will_evaluate_is_refused_rather_than_stored()
    {
        // Refused here so nobody authors a property whose only possible value is a limit error.
        var schema = SchemaOf(
            Formula("margin", new string('1', FormulaReferences.MaximumExpressionLength + 1)));

        Assert.Contains("longer than", PropertySchemaRules.Refuse(schema), StringComparison.Ordinal);
    }

    [Fact]
    public void A_property_that_is_not_a_formula_cannot_carry_an_expression()
    {
        // Not merely untidy: retyping it to a formula later would make an expression nobody had
        // read start evaluating.
        var definition = new PropertyDefinition("note", "Note", PropertyType.Text, [], false, "[a] + 1");

        Assert.Equal(
            "'Note' is not a formula, so it cannot carry an expression.",
            PropertySchemaRules.Refuse(SchemaOf(definition)));
    }

    [Fact]
    public void A_formula_property_cannot_be_required()
    {
        var definition = new PropertyDefinition(
            "margin",
            "Margin",
            PropertyType.Formula,
            [],
            Required: true,
            "[price] - [cost]");

        Assert.Contains("cannot be required", PropertySchemaRules.Refuse(SchemaOf(definition)), StringComparison.Ordinal);
    }

    [Fact]
    public void A_schema_whose_formulas_refer_in_a_circle_is_refused()
    {
        var schema = SchemaOf(Formula("a", "[b] + 1"), Formula("b", "[a] + 1"));

        Assert.Equal(
            "'a' is a formula that refers back to itself, directly or through another formula.",
            PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void A_formula_reading_another_formula_is_accepted_when_it_does_not_close_a_circle()
    {
        var schema = SchemaOf(
            Formula("remaining", "[budget] - [spent]"),
            Formula("headroom", "[remaining] / [budget]"));

        Assert.Null(PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void A_stored_formula_that_lost_its_expression_is_dropped_rather_than_read_as_an_error()
    {
        // Reading a schema is total: what cannot be interpreted is left out, so the items beneath
        // it stay readable. A formula with nothing to evaluate is exactly that case.
        var read = PropertySchemaJson.Read(
            """{"inherit":true,"properties":[{"key":"margin","label":"Margin","type":"formula"}]}""");

        Assert.Empty(read.Properties);
    }

    [Fact]
    public void An_expression_stored_against_a_type_that_cannot_carry_one_is_not_read_back()
    {
        // The writer's rules refuse this, so it can only arrive by hand-editing the column. Read
        // back it would be dormant text that a retype turns into a live formula.
        var read = PropertySchemaJson.Read(
            """{"inherit":true,"properties":[{"key":"note","label":"Note","type":"text","expression":"[a]"}]}""");

        Assert.Null(Assert.Single(read.Properties).Expression);
    }

    [Fact]
    public void No_value_may_be_written_to_a_formula_property()
    {
        var schema = SchemaOf(Formula("margin", "[price] - [cost]"));

        var violations = PropertyValidator.ValidateSupplied("""{"margin":42}""", schema);

        Assert.Equal(
            "Margin is computed from a formula and cannot be set.",
            Assert.Single(violations).Reason);
    }

    [Fact]
    public void A_write_that_leaves_a_formula_property_alone_is_accepted()
    {
        var schema = SchemaOf(Formula("margin", "[price] - [cost]"));

        Assert.Empty(PropertyValidator.ValidateSupplied("""{"price":10}""", schema));
    }

    [Fact]
    public void Clearing_a_formula_property_is_accepted_because_there_was_never_a_value_there()
    {
        // An explicit null reads as absent everywhere else in the validator, and a client sending
        // the whole bag back with the computed keys nulled must not be refused for a value it is
        // not setting.
        var schema = SchemaOf(Formula("margin", "[price] - [cost]"));

        Assert.Empty(PropertyValidator.ValidateSupplied("""{"margin":null}""", schema));
    }

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Formula(string key, string expression) =>
        new(
            key,
            char.ToUpperInvariant(key[0]) + key[1..],
            PropertyType.Formula,
            ImmutableArray<string>.Empty,
            Required: false,
            expression);
}
