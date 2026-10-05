using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The inheritance rule: what an item sees is every ancestor's schema, nearest declaration winning.
/// </summary>
/// <remarks>
/// <para>
/// The merge is the whole of ADR-0007 in one function, and the two halves of it fail differently.
/// Get precedence wrong and the outermost schema becomes unoverridable - a workspace-wide "Status"
/// that no project folder can narrow, which turns any shared schema into a commitment nobody can
/// walk back. Get ordering wrong and overriding one property reshuffles a list view's columns for
/// everybody, which reads as a bug to every person who did not make the edit.
/// </para>
/// <para>
/// Merging is written as an explicit two-level or three-level chain in each test rather than a
/// helper, because the argument order - farther first, nearer second - is the easiest thing in the
/// file to get backwards, and a helper would hide it.
/// </para>
/// </remarks>
public sealed class PropertySchemaTests
{
    [Fact]
    public void A_nearer_declaration_of_a_key_wins()
    {
        var workspace = SchemaOf(Property("status", PropertyType.Select, label: "Status"));
        var folder = SchemaOf(Property("status", PropertyType.Text, label: "Stage"));

        var effective = PropertySchema.Merge(workspace, folder);

        var status = Assert.Single(effective.Properties);
        Assert.Equal("Stage", status.Label);
        Assert.Equal(PropertyType.Text, status.Type);
    }

    [Fact]
    public void A_nearer_redefinition_keeps_the_position_the_farther_schema_gave_it()
    {
        var workspace = SchemaOf(
            Property("status", PropertyType.Select),
            Property("owner", PropertyType.Text),
            Property("due", PropertyType.Date));

        var folder = SchemaOf(Property("owner", PropertyType.Select, label: "Assignee"));

        var effective = PropertySchema.Merge(workspace, folder);

        // Second, where the workspace put it - not last, where the redefinition was written. The
        // order is the column order of every list view beneath this folder.
        string[] expected = ["status", "owner", "due"];
        Assert.Equal(expected, Keys(effective));
        Assert.Equal("Assignee", effective.Find("owner")?.Label);
    }

    [Fact]
    public void A_property_only_the_nearer_schema_declares_is_appended_after_the_inherited_ones()
    {
        var workspace = SchemaOf(Property("status", PropertyType.Select));
        var folder = SchemaOf(
            Property("status", PropertyType.Select, label: "Stage"),
            Property("sprint", PropertyType.Text));

        string[] expected = ["status", "sprint"];
        Assert.Equal(expected, Keys(PropertySchema.Merge(workspace, folder)));
    }

    [Fact]
    public void A_property_no_nearer_schema_mentions_survives_the_whole_chain()
    {
        var workspace = SchemaOf(
            Property("status", PropertyType.Select),
            Property("owner", PropertyType.Text));

        var project = SchemaOf(Property("sprint", PropertyType.Text));
        var folder = SchemaOf(Property("owner", PropertyType.Select, label: "Assignee"));

        // Resolution runs outwards, so each step puts what has been gathered on the nearer side.
        var effective = PropertySchema.Merge(workspace, PropertySchema.Merge(project, folder));

        string[] expected = ["status", "owner", "sprint"];
        Assert.Equal(expected, Keys(effective));
        Assert.Equal("Assignee", effective.Find("owner")?.Label);
    }

    [Fact]
    public void Merging_an_empty_nearer_schema_returns_the_farther_one_untouched()
    {
        var workspace = SchemaOf(Property("status", PropertyType.Select));

        // The common case by far: most items declare nothing, and resolution walks through them.
        // Returning the same instance keeps that walk free of allocation.
        Assert.Same(workspace, PropertySchema.Merge(workspace, PropertySchema.Empty));
    }

    [Fact]
    public void Merging_over_an_empty_farther_schema_returns_the_nearer_one_untouched()
    {
        var folder = SchemaOf(Property("sprint", PropertyType.Text));

        Assert.Same(folder, PropertySchema.Merge(PropertySchema.Empty, folder));
    }

    [Fact]
    public void The_merged_schema_carries_the_nearer_schemas_inheritance_flag()
    {
        var workspace = SchemaOf(Property("status", PropertyType.Select));
        var folder = new PropertySchema
        {
            Properties = [Property("sprint", PropertyType.Text)],
            Inherit = false,
        };

        // The nearer flag is the one a further merge has to obey, so it has to be the one that
        // survives: a scratch folder that refuses to inherit must keep refusing as resolution
        // continues upwards, not inherit the workspace's willingness on the way past.
        Assert.False(PropertySchema.Merge(workspace, folder).Inherit);
    }

    [Fact]
    public void Merging_leaves_both_of_its_arguments_as_they_were()
    {
        var workspace = SchemaOf(Property("status", PropertyType.Select, label: "Status"));
        var folder = SchemaOf(Property("status", PropertyType.Text, label: "Stage"));

        _ = PropertySchema.Merge(workspace, folder);

        // A resolver caches schemas per item and merges the same instance into several chains, so
        // a merge that mutated an input would corrupt every other branch it had been used in.
        Assert.Equal("Status", workspace.Find("status")?.Label);
        Assert.Equal("Stage", folder.Find("status")?.Label);
    }

    [Fact]
    public void Find_answers_with_nothing_for_a_key_the_schema_does_not_declare()
    {
        var schema = SchemaOf(Property("status", PropertyType.Select));

        Assert.Null(schema.Find("Status"));
        Assert.Null(schema.Find("missing"));
        Assert.NotNull(schema.Find("status"));
    }

    [Fact]
    public void An_empty_schema_declares_nothing_and_lets_the_chain_above_it_through()
    {
        Assert.True(PropertySchema.Empty.IsEmpty);
        Assert.Empty(PropertySchema.Empty.Properties);

        // Inheriting is the default an item with no schema of its own must resolve to; the
        // alternative would make every unconfigured item a barrier its descendants inherit through.
        Assert.True(PropertySchema.Empty.Inherit);
    }

    private static string[] Keys(PropertySchema schema) =>
        [.. schema.Properties.Select(property => property.Key)];

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Property(
        string key,
        PropertyType type,
        string? label = null,
        bool required = false) =>
        new(key, label ?? key, type, ImmutableArray<string>.Empty, required);
}
