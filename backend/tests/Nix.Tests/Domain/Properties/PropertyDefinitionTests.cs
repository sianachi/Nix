using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// What a single declared property will admit.
/// </summary>
/// <remarks>
/// Small surface, but it is the one the validator delegates the select types to, so a lenient
/// answer here is a value in the column that no board column will ever match.
/// </remarks>
public sealed class PropertyDefinitionTests
{
    [Fact]
    public void A_declared_option_is_allowed()
    {
        Assert.True(Status().Allows("Doing"));
    }

    [Fact]
    public void A_value_the_property_never_declared_is_not_allowed()
    {
        Assert.False(Status().Allows("Shipped"));
    }

    [Theory]
    [InlineData("doing")]
    [InlineData("DOING")]
    [InlineData(" Doing")]
    [InlineData("Doing ")]
    public void Matching_is_ordinal_so_a_near_miss_is_a_different_option(string value)
    {
        // Options are identifiers a board groups by, not prose. Folding case or trimming here would
        // make "Doing" and "doing" one column in the schema and two columns in every query that
        // groups on the raw value.
        Assert.False(Status().Allows(value));
    }

    [Fact]
    public void A_property_that_declares_no_options_admits_nothing()
    {
        // Which is why the validator's select check reports rather than waves through: a select
        // whose options were emptied refuses every value instead of accepting every value.
        var free = new PropertyDefinition("notes", "Notes", PropertyType.Text, [], Required: false);

        Assert.False(free.Allows("anything"));
        Assert.False(free.Allows(string.Empty));
    }

    private static PropertyDefinition Status()
    {
        ImmutableArray<string> options = ["Todo", "Doing", "Done"];
        return new PropertyDefinition("status", "Status", PropertyType.Select, options, Required: false);
    }
}
