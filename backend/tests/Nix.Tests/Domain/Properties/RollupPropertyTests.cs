using System.Collections.Immutable;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The rollup property type through Core: what a schema may declare, what survives storage, what a
/// write may do to a folded value, and what each fold reduces to.
/// </summary>
public sealed class RollupPropertyTests
{
    [Fact]
    public void A_rollup_is_stored_with_the_fold_and_the_property_it_folds()
    {
        var schema = SchemaOf(Rollup("hours", RollupAggregate.Sum, "estimate"));

        Assert.Null(PropertySchemaRules.Refuse(schema));

        var read = Assert.Single(PropertySchemaJson.Read(PropertySchemaJson.Write(schema)).Properties);

        Assert.Equal(RollupAggregate.Sum, read.Aggregate);
        Assert.Equal("estimate", read.Source);
    }

    [Fact]
    public void A_count_may_be_taken_of_the_children_themselves()
    {
        var schema = SchemaOf(Rollup("tasks", RollupAggregate.Count, source: null));

        Assert.Null(PropertySchemaRules.Refuse(schema));

        var read = Assert.Single(PropertySchemaJson.Read(PropertySchemaJson.Write(schema)).Properties);

        Assert.Equal(RollupAggregate.Count, read.Aggregate);
        Assert.Null(read.Source);
    }

    [Fact]
    public void Every_other_fold_needs_a_property_to_fold()
    {
        var schema = SchemaOf(Rollup("hours", RollupAggregate.Sum, source: null));

        Assert.Contains(
            "needs a property to fold",
            PropertySchemaRules.Refuse(schema),
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_rollup_with_no_fold_is_refused()
    {
        var definition = new PropertyDefinition(
            "hours",
            "Hours",
            PropertyType.Rollup,
            [],
            Required: false,
            Expression: null,
            Aggregate: null,
            Source: "estimate");

        Assert.Contains(
            "needs to say how it folds",
            PropertySchemaRules.Refuse(SchemaOf(definition)),
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_rollup_cannot_fold_a_property_with_its_own_key()
    {
        // The schema cascades, so a rollup keyed like what it folds is inherited by the children
        // it folds - where it would then fold itself.
        var schema = SchemaOf(Rollup("estimate", RollupAggregate.Sum, "estimate"));

        Assert.Contains(
            "would fold itself",
            PropertySchemaRules.Refuse(schema),
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_property_that_is_not_a_rollup_cannot_say_how_to_fold_children()
    {
        var definition = new PropertyDefinition(
            "hours",
            "Hours",
            PropertyType.Number,
            [],
            Required: false,
            Expression: null,
            Aggregate: RollupAggregate.Sum,
            Source: "estimate");

        Assert.Equal(
            "'Hours' is not a rollup, so it cannot say how to fold children.",
            PropertySchemaRules.Refuse(SchemaOf(definition)));
    }

    [Fact]
    public void A_rollup_cannot_be_required()
    {
        var definition = Rollup("tasks", RollupAggregate.Count, source: null) with { Required = true };

        Assert.Contains(
            "cannot be required",
            PropertySchemaRules.Refuse(SchemaOf(definition)),
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_stored_rollup_whose_fold_this_build_does_not_know_is_dropped()
    {
        // Reading is total: a fold this build cannot perform is left out rather than replaced with
        // one nobody chose, so the items beneath the schema stay readable.
        var read = PropertySchemaJson.Read(
            """{"inherit":true,"properties":[{"key":"h","label":"H","type":"rollup","aggregate":"median","source":"x"}]}""");

        Assert.Empty(read.Properties);
    }

    [Fact]
    public void A_stored_rollup_that_lost_the_property_it_folds_is_dropped()
    {
        var read = PropertySchemaJson.Read(
            """{"inherit":true,"properties":[{"key":"h","label":"H","type":"rollup","aggregate":"sum"}]}""");

        Assert.Empty(read.Properties);
    }

    [Fact]
    public void No_value_may_be_written_to_a_rollup()
    {
        var schema = SchemaOf(Rollup("hours", RollupAggregate.Sum, "estimate"));

        var violations = PropertyValidator.ValidateSupplied("""{"hours":40}""", schema);

        Assert.Equal(
            "Hours is rolled up from this item's children and cannot be set.",
            Assert.Single(violations).Reason);
    }

    [Fact]
    public void Every_fold_this_build_defines_survives_being_written_and_read_back()
    {
        foreach (var aggregate in Enum.GetValues<RollupAggregate>())
        {
            Assert.True(RollupAggregates.TryParse(RollupAggregates.ToText(aggregate), out var read));
            Assert.Equal(aggregate, read);
        }
    }

    [Theory]
    // A count naming a property counts the children carrying one, not the children.
    [InlineData(RollupAggregate.Count, "4")]
    [InlineData(RollupAggregate.Sum, "24")]
    [InlineData(RollupAggregate.Min, "2")]
    [InlineData(RollupAggregate.Max, "10")]
    [InlineData(RollupAggregate.Average, "6")]
    public void Each_numeric_fold_reduces_the_values_it_is_named_for(
        RollupAggregate aggregate,
        string expected)
    {
        // Five children, four of them carrying numbers summing to 24: 2, 4, 8, 10.
        var fold = new ChildAggregate(
            Children: 5,
            Present: 4,
            Numbers: 4,
            Total: 24m,
            Smallest: 2m,
            Largest: 10m,
            Booleans: 0,
            Truths: 0);

        Assert.Equal(expected, fold.Reduce(aggregate, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void A_count_of_the_children_counts_the_ones_with_no_value_too()
    {
        var fold = new ChildAggregate(5, 4, 4, 24m, 2m, 10m, 0, 0);

        Assert.Equal("5", fold.Reduce(RollupAggregate.Count, sourceless: true)?.ToJsonString());
        Assert.Equal("4", fold.Reduce(RollupAggregate.Count, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void An_average_is_taken_over_the_children_that_have_a_value()
    {
        // Counting the blanks as zero would make a rollup fall as somebody added rows they had not
        // filled in yet, which reads as work getting worse when nothing changed.
        var fold = new ChildAggregate(100, 2, 2, 10m, 4m, 6m, 0, 0);

        Assert.Equal("5", fold.Reduce(RollupAggregate.Average, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void An_extreme_or_an_average_over_no_numbers_is_no_answer_rather_than_zero()
    {
        // Zero is a real answer a person would act on; "nothing to average" is not.
        var fold = ChildAggregate.Empty;

        Assert.Null(fold.Reduce(RollupAggregate.Min, sourceless: false));
        Assert.Null(fold.Reduce(RollupAggregate.Max, sourceless: false));
        Assert.Null(fold.Reduce(RollupAggregate.Average, sourceless: false));
    }

    [Fact]
    public void A_sum_over_no_numbers_is_zero_because_an_empty_sum_is()
    {
        Assert.Equal(
            "0",
            ChildAggregate.Empty.Reduce(RollupAggregate.Sum, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void Any_and_all_read_the_children_that_carry_a_boolean()
    {
        var mixed = new ChildAggregate(4, 3, 0, null, null, null, Booleans: 3, Truths: 1);
        var every = new ChildAggregate(4, 3, 0, null, null, null, Booleans: 3, Truths: 3);

        Assert.Equal("true", mixed.Reduce(RollupAggregate.Any, sourceless: false)?.ToJsonString());
        Assert.Equal("false", mixed.Reduce(RollupAggregate.All, sourceless: false)?.ToJsonString());
        Assert.Equal("true", every.Reduce(RollupAggregate.All, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void All_over_values_that_are_not_booleans_is_no_answer_rather_than_true()
    {
        // The most damaging possible default for the most misleading possible reason: three
        // hundred children none of whose values is true or false is not a container where
        // everything is done.
        var fold = new ChildAggregate(300, 300, 300, 900m, 1m, 5m, Booleans: 0, Truths: 0);

        Assert.Null(fold.Reduce(RollupAggregate.All, sourceless: false));
    }

    [Fact]
    public void A_total_too_large_to_represent_is_no_answer_rather_than_zero()
    {
        // The fold declines to compute a sum that will not fit rather than crashing the listing;
        // publishing that as zero would be a figure somebody acts on.
        var fold = new ChildAggregate(20, 20, 20, Total: null, null, null, 0, 0);

        Assert.Null(fold.Reduce(RollupAggregate.Sum, sourceless: false));
    }

    [Fact]
    public void All_is_true_of_no_children_because_an_empty_conjunction_is()
    {
        Assert.Equal(
            "true",
            ChildAggregate.Empty.Reduce(RollupAggregate.All, sourceless: false)?.ToJsonString());
        Assert.Equal(
            "false",
            ChildAggregate.Empty.Reduce(RollupAggregate.Any, sourceless: false)?.ToJsonString());
    }

    [Fact]
    public void A_count_over_no_children_is_zero_rather_than_absent()
    {
        // The row a person is most likely to be checking. Absent, the column would be blank on
        // exactly the containers whose emptiness is the answer.
        Assert.Equal(
            "0",
            ChildAggregate.Empty.Reduce(RollupAggregate.Count, sourceless: true)?.ToJsonString());
    }

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Rollup(string key, RollupAggregate aggregate, string? source) =>
        new(
            key,
            char.ToUpperInvariant(key[0]) + key[1..],
            PropertyType.Rollup,
            ImmutableArray<string>.Empty,
            Required: false,
            Expression: null,
            Aggregate: aggregate,
            Source: source);
}
