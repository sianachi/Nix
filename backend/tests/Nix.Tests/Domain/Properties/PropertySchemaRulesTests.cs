using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// What a declared schema has to satisfy before it is stored - the shared rules every
/// schema-writing boundary applies through <see cref="PropertySchemaRules.Refuse"/>.
/// </summary>
public sealed class PropertySchemaRulesTests
{
    [Fact]
    public void A_schema_may_declare_one_of_each_task_type_under_its_reserved_key()
    {
        // The labels are free on purpose: a workspace calls its due date "Deadline" and the key
        // still says which role it plays.
        var schema = SchemaOf(
            Property("due_date", PropertyType.DueDate, "Deadline"),
            Property("start_date", PropertyType.StartDate, "Kickoff"),
            Property("completion", PropertyType.Completion, "Shipped"),
            Property("priority", PropertyType.Priority, "Urgency"),
            Property("estimate", PropertyType.Estimate, "Hours"),
            Property("assignee", PropertyType.Assignee, "Owner"));

        Assert.Null(PropertySchemaRules.Refuse(schema));
    }

    [Theory]
    [InlineData(PropertyType.DueDate, "due_date")]
    [InlineData(PropertyType.StartDate, "start_date")]
    [InlineData(PropertyType.Completion, "completion")]
    [InlineData(PropertyType.Priority, "priority")]
    [InlineData(PropertyType.Estimate, "estimate")]
    [InlineData(PropertyType.Assignee, "assignee")]
    public void A_task_type_under_any_other_key_is_refused_naming_the_required_one(
        PropertyType type,
        string requiredKey)
    {
        // A task type names a role, and a smart list that means "the due date" compiles
        // cross-workspace against the key - so the key is the role's name, everywhere, and the
        // refusal points at the label as the place for the workspace's own word.
        var schema = SchemaOf(Property("deadline", type, "Deadline"));

        var reason = PropertySchemaRules.Refuse(schema);

        Assert.Equal(
            $"A {requiredKey} property must use the key '{requiredKey}'; 'deadline' is a "
                + "different name for a role the whole workspace has to agree on. Rename the "
                + "label instead.",
            reason);
    }

    [Fact]
    public void A_second_property_of_the_same_task_type_cannot_be_expressed()
    {
        // Singularity is emergent, not separately checked: the reserved key forces a second
        // due date onto the same key, and the duplicate-key rule refuses that first.
        var schema = SchemaOf(
            Property("due_date", PropertyType.DueDate, "Due"),
            Property("due_date", PropertyType.DueDate, "Also due"));

        Assert.Equal(
            "'due_date' is declared more than once; a property cannot mean two things.",
            PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void Two_plain_properties_of_the_same_type_stay_allowed()
    {
        // The reservation is a property of the task types' meaning, not of types in general: a
        // schema with a created date and a reviewed date is two dates and entirely ordinary.
        var schema = SchemaOf(
            Property("created", PropertyType.Date, "Created"),
            Property("reviewed", PropertyType.Date, "Reviewed"),
            Property("flagged", PropertyType.Checkbox, "Flagged"),
            Property("archived", PropertyType.Checkbox, "Archived"));

        Assert.Null(PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void A_plain_property_may_sit_on_a_reserved_key()
    {
        // Deliberate, and worth pinning: a plain date keyed `due_date` reads identically to a
        // due_date everywhere values are compared (the projection and the queries go through the
        // key), so refusing it would break workspaces that adopted the convention before the
        // types existed - the exact people 3.1 is for.
        var schema = SchemaOf(Property("due_date", PropertyType.Date, "Due"));

        Assert.Null(PropertySchemaRules.Refuse(schema));
    }

    [Fact]
    public void A_plain_text_property_may_sit_on_the_assignee_key()
    {
        // The same reasoning as the due_date case above, for the newer reserved key: a workspace
        // that was already keying a free-text owner field "assignee" before this type existed must
        // not have that schema retroactively refused.
        var schema = SchemaOf(Property("assignee", PropertyType.Text, "Owner"));

        Assert.Null(PropertySchemaRules.Refuse(schema));
    }

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Property(
        string key,
        PropertyType type,
        string label,
        bool required = false,
        ImmutableArray<string> options = default) =>
        new(key, label, type, options.IsDefault ? [] : options, required);
}
