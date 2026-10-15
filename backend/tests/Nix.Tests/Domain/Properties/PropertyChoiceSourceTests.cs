using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

public sealed class PropertyChoiceSourceTests
{
    [Theory]
    [InlineData(PropertyType.Text)]
    [InlineData(PropertyType.Select)]
    [InlineData(PropertyType.MultiSelect)]
    public void Sources_round_trip_and_empty_dynamic_choices_are_valid(PropertyType type)
    {
        var source = new PropertyChoiceSource(Guid.NewGuid(), "person");
        var field = new PropertyDefinition("who", "Who", type, [], false, ChoiceSource: source);
        var schema = new PropertySchema { Properties = [field], Inherit = true };

        Assert.Null(PropertySchemaRules.Refuse(schema));
        Assert.Equal(source, Assert.Single(PropertySchemaJson.Read(PropertySchemaJson.Write(schema)).Properties).ChoiceSource);
        Assert.Null(PropertySchemaRules.Refuse(schema with { Properties = [field with { ChoiceSource = source with { ItemId = null } }] }));
    }

    [Theory]
    [InlineData(PropertyType.Number, "person")]
    [InlineData(PropertyType.Text, "")]
    [InlineData(PropertyType.Select, "$inside")]
    public void Invalid_sources_are_refused(PropertyType type, string field)
    {
        var property = new PropertyDefinition("who", "Who", type, [], false, ChoiceSource: new(null, field));
        Assert.NotNull(PropertySchemaRules.Refuse(new PropertySchema { Properties = [property], Inherit = true }));
    }

    [Theory]
    [InlineData(PropertyType.Select, "\"New person\"")]
    [InlineData(PropertyType.MultiSelect, "[\"Alex\",\"New person\"]")]
    public void Dynamic_choices_allow_new_text_without_mutating_the_schema(PropertyType type, string value)
    {
        var field = new PropertyDefinition("who", "Who", type, [], false, ChoiceSource: new(null, "who"));
        var schema = new PropertySchema { Properties = [field], Inherit = true };
        var write = "{\"who\":" + value + "}";
        Assert.Empty(PropertyValidator.ValidateSupplied(write, schema));
    }
}
