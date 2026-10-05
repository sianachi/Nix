using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The seam between the <c>item.schema</c> column and everything that reasons about schemas.
/// </summary>
/// <remarks>
/// <para>
/// Reading is total, and that is the claim most of this file is about. The column holds data an
/// older build may not fully understand, and a schema it cannot parse must never make the items
/// beneath it unreadable - a folder with a broken schema shows fewer fields, not an error page. So
/// every malformed shape below has to come back as a schema, and the answer only ever shrinks.
/// </para>
/// <para>
/// The round trip is the other half: what the endpoint validated and stored has to be exactly what
/// the next request resolves, or validation was performed against a schema nobody is using.
/// </para>
/// </remarks>
public sealed class PropertySchemaJsonTests
{
    [Fact]
    public void A_written_schema_reads_back_as_the_one_that_was_written()
    {
        ImmutableArray<string> options = ["Todo", "Doing", "Done"];
        var schema = new PropertySchema
        {
            Properties =
            [
                new PropertyDefinition("status", "Status", PropertyType.Select, options, Required: true),
                new PropertyDefinition("due", "Due date", PropertyType.Date, [], Required: false),
                new PropertyDefinition("tags", "Tags", PropertyType.MultiSelect, ["a", "b"], Required: false),
                new PropertyDefinition("link", "Link", PropertyType.Url, [], Required: false),
                new PropertyDefinition("done", "Done", PropertyType.Checkbox, [], Required: false),
                new PropertyDefinition("estimate", "Estimate", PropertyType.Number, [], Required: false),
                new PropertyDefinition("notes", "Notes", PropertyType.Text, [], Required: false),
            ],
            Inherit = false,
        };

        var read = PropertySchemaJson.Read(PropertySchemaJson.Write(schema));

        Assert.Equal(schema.Inherit, read.Inherit);
        Assert.Equal(schema.Properties.Length, read.Properties.Length);
        for (var index = 0; index < schema.Properties.Length; index++)
        {
            AssertSameProperty(schema.Properties[index], read.Properties[index]);
        }
    }

    [Fact]
    public void Options_belong_to_the_select_types_and_are_dropped_for_the_rest()
    {
        // A stored options list on a text property is either an authoring mistake or a leftover
        // from a retype. Either way it decides nothing, and carrying it forward would let a later
        // retype back to select resurrect a list nobody has looked at since.
        var read = PropertySchemaJson.Read(
            """
            {"properties":[{"key":"notes","type":"text","options":["a","b"]}]}
            """);

        Assert.Empty(Assert.Single(read.Properties).Options);
    }

    [Fact]
    public void An_option_declared_twice_is_offered_once()
    {
        var read = PropertySchemaJson.Read(
            """
            {"properties":[{"key":"status","type":"select","options":["Todo","Todo","Done"]}]}
            """);

        string[] expected = ["Todo", "Done"];
        Assert.Equal(expected, Assert.Single(read.Properties).Options.ToArray());
    }

    [Fact]
    public void A_property_missing_a_label_is_labelled_by_its_key()
    {
        // Better a person sees "status" than an empty column header, and it keeps the key visible
        // to whoever has to fix the schema.
        var read = PropertySchemaJson.Read("""{"properties":[{"key":"status","type":"select"}]}""");

        Assert.Equal("status", Assert.Single(read.Properties).Label);
    }

    [Fact]
    public void A_property_whose_type_this_build_does_not_know_is_dropped_and_the_others_kept()
    {
        // The single most valuable line of the reader. A newer build adds a "relation" type, an
        // older instance still serving traffic reads the same row, and the outcome is one property
        // it cannot show - not a schema it refuses, and not a rule it invented for a type it has
        // never heard of.
        var read = PropertySchemaJson.Read(
            """
            {"properties":[
              {"key":"status","type":"select","options":["Todo"]},
              {"key":"owner","type":"relation"},
              {"key":"due","type":"date"}
            ]}
            """);

        string[] expected = ["status", "due"];
        Assert.Equal(expected, Keys(read));
    }

    [Fact]
    public void The_first_declaration_of_a_duplicated_key_wins()
    {
        // A bag holds one value per key, so a schema declaring the key twice cannot mean both.
        // First wins because the alternative makes a property's behaviour depend on array order in
        // a way nobody authored on purpose.
        var read = PropertySchemaJson.Read(
            """
            {"properties":[
              {"key":"status","label":"First","type":"select"},
              {"key":"status","label":"Second","type":"text"}
            ]}
            """);

        var status = Assert.Single(read.Properties);
        Assert.Equal("First", status.Label);
        Assert.Equal(PropertyType.Select, status.Type);
    }

    [Fact]
    public void An_entry_with_no_usable_key_is_dropped()
    {
        var read = PropertySchemaJson.Read(
            """
            {"properties":[
              {"type":"text"},
              {"key":"","type":"text"},
              {"key":null,"type":"text"},
              {"key":7,"type":"text"},
              "status",
              ["status"],
              null,
              {"key":"kept","type":"text"}
            ]}
            """);

        string[] expected = ["kept"];
        Assert.Equal(expected, Keys(read));
    }

    [Fact]
    public void A_document_that_says_nothing_about_inheriting_inherits()
    {
        // The permissive default, matching PropertySchema.Empty: a schema authored before the flag
        // existed must not start cutting its subtree off from everything above it.
        Assert.True(PropertySchemaJson.Read("""{"properties":[]}""").Inherit);
        Assert.True(PropertySchemaJson.Read("""{"inherit":"false","properties":[]}""").Inherit);
        Assert.False(PropertySchemaJson.Read("""{"inherit":false,"properties":[]}""").Inherit);
    }

    [Fact]
    public void A_properties_member_that_is_not_a_list_costs_the_properties_and_nothing_else()
    {
        // The flag parsed cleanly, so it is honoured. Discarding it as well would silently reopen
        // a subtree that was deliberately detached.
        var read = PropertySchemaJson.Read("""{"inherit":false,"properties":{"status":"select"}}""");

        Assert.Empty(read.Properties);
        Assert.False(read.Inherit);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json at all")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("[{\"key\":\"status\",\"type\":\"text\"}]")]
    [InlineData("42")]
    [InlineData("\"schema\"")]
    [InlineData("null")]
    [InlineData("{}")]
    public void Whatever_is_in_the_column_reads_as_a_schema_rather_than_throwing(string? json)
    {
        var read = PropertySchemaJson.Read(json);

        Assert.True(read.IsEmpty);
        Assert.True(read.Inherit);
    }

    private static string[] Keys(PropertySchema schema) =>
        [.. schema.Properties.Select(property => property.Key)];

    private static void AssertSameProperty(PropertyDefinition expected, PropertyDefinition actual)
    {
        // Compared member by member because a record holding an ImmutableArray compares that array
        // by reference, so the generated equality would pass for the wrong reason here.
        Assert.Equal(expected.Key, actual.Key);
        Assert.Equal(expected.Label, actual.Label);
        Assert.Equal(expected.Type, actual.Type);
        Assert.Equal(expected.Required, actual.Required);
        Assert.Equal(expected.Options.ToArray(), actual.Options.ToArray());
    }
}
