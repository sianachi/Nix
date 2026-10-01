using System.Collections.Immutable;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// The fields ADR-0054 adds to a view: several sort keys, collapsed groups, soft group limits and
/// column summaries - how somebody arranges what a container shows, none of it a placement.
/// </summary>
public sealed class ViewArrangementTests
{
    private static ViewDefinition List(string id = "v1") =>
        new(id, "Everything", ViewKind.List, [], null, [], null, null, false);

    [Fact]
    public void The_arrangement_fields_round_trip_through_the_column()
    {
        var view = List() with
        {
            Sorts = [new ViewSort("status", false), new ViewSort("due", true)],
            CollapsedGroups = ["Done", ""],
            GroupLimits = [new ViewGroupLimit("Doing", 5)],
            Aggregates = [new ViewAggregate("points", ViewAggregateFunctions.Sum)],
        };

        var read = ViewDefinitionsJson.Read(ViewDefinitionsJson.Write([view])).Views.Single();

        Assert.Equal(view.Sorts, read.Sorts);
        Assert.Equal(view.CollapsedGroups, read.CollapsedGroups);
        Assert.Equal(view.GroupLimits, read.GroupLimits);
        Assert.Equal(view.Aggregates, read.Aggregates);
    }

    [Fact]
    public void An_unarranged_view_stores_none_of_the_keys()
    {
        var json = ViewDefinitionsJson.Write([List()])!;

        Assert.DoesNotContain("sorts", json, StringComparison.Ordinal);
        Assert.DoesNotContain("collapsedGroups", json, StringComparison.Ordinal);
        Assert.DoesNotContain("groupLimits", json, StringComparison.Ordinal);
        Assert.DoesNotContain("aggregates", json, StringComparison.Ordinal);
    }

    [Fact]
    public void A_malformed_arrangement_entry_costs_the_entry_and_never_the_view()
    {
        const string json = """
            {"views":[{"id":"v1","name":"All","kind":"list","sortDescending":false,
              "sorts":[{"property":"a"},{"property":"a"},{"nope":1},{"property":"b","descending":true}],
              "groupLimits":[{"group":"x","limit":0},{"group":"y","limit":3},{"limit":2}],
              "aggregates":[{"property":"p","function":"median"},{"property":"q","function":"sum"}]}]}
            """;

        var view = ViewDefinitionsJson.Read(json).Views.Single();

        Assert.Equal([new ViewSort("a", false), new ViewSort("b", true)], view.Sorts);
        Assert.Equal([new ViewGroupLimit("y", 3)], view.GroupLimits);
        Assert.Equal([new ViewAggregate("q", "sum")], view.Aggregates);
    }

    [Theory]
    [MemberData(nameof(RefusedArrangements))]
    public void A_malformed_arrangement_is_refused_on_write(ViewDefinition view) =>
        Assert.NotNull(ViewDefinitionRules.Refuse([view], null));

    public static TheoryData<ViewDefinition> RefusedArrangements() =>
        new()
        {
            List() with
            {
                Sorts =
                [
                    new ViewSort("a", false), new ViewSort("b", false),
                    new ViewSort("c", false), new ViewSort("d", false),
                ],
            },
            List() with { Sorts = [new ViewSort("a", false), new ViewSort("a", true)] },
            List() with { Sorts = [new ViewSort("", false)] },
            List() with { GroupLimits = [new ViewGroupLimit("x", 0)] },
            List() with { GroupLimits = [new ViewGroupLimit("x", 1000)] },
            List() with { GroupLimits = [new ViewGroupLimit("x", 2), new ViewGroupLimit("x", 3)] },
            List() with { Aggregates = [new ViewAggregate("p", "median")] },
            List() with { Aggregates = [new ViewAggregate("p", "sum"), new ViewAggregate("p", "max")] },
            List() with { CollapsedGroups = [.. Enumerable.Range(0, 65).Select(index => $"g{index}")] },
        };

    [Fact]
    public void A_well_formed_arrangement_is_storable()
    {
        var view = List() with
        {
            Sorts = [new ViewSort("status", false), new ViewSort("title", true)],
            CollapsedGroups = [""],
            GroupLimits = [new ViewGroupLimit("", 9)],
            Aggregates = [.. ViewAggregateFunctions.All.Select((function, index) => new ViewAggregate($"p{index}", function))],
        };

        Assert.Null(ViewDefinitionRules.Refuse([view], null));
    }

    [Fact]
    public void A_container_view_may_use_the_wider_operators_and_a_query_view_may_not_yet()
    {
        var rule = new FilterRule("title", QueryOperators.Contains, "plan");

        Assert.Null(ViewDefinitionRules.Refuse([List() with { Filters = [rule] }], null));

        var query = new ViewDefinition("q", "Search", ViewKind.Query, [], null, [], null, null, false)
        {
            Filters = [rule],
        };
        Assert.NotNull(ViewDefinitionRules.Refuse([query], null));
    }

    [Fact]
    public void The_first_sort_key_is_mirrored_into_the_single_key_fields()
    {
        var view = List() with
        {
            SortBy = "ignored",
            SortDescending = false,
            Sorts = [new ViewSort("due", true), new ViewSort("title", false)],
        };

        var mirrored = ViewSorting.MirrorPrimary(view);

        Assert.Equal("due", mirrored.SortBy);
        Assert.True(mirrored.SortDescending);
        Assert.Equal(2, mirrored.Sorts.Length);
    }

    [Fact]
    public void Reading_mirrors_the_first_sort_key_into_the_single_key_fields()
    {
        // A writer that stores the column without going through the view endpoint - a template
        // merge, a document import - may leave sortBy naming something else. The reader mirrors
        // too, so every consumer of the single-key fields agrees with the list.
        const string json = """
            {"views":[{"id":"v1","name":"All","kind":"list","sortBy":"title","sortDescending":false,
              "sorts":[{"property":"due","descending":true},{"property":"title"}]}]}
            """;

        var view = ViewDefinitionsJson.Read(json).Views.Single();

        Assert.Equal("due", view.SortBy);
        Assert.True(view.SortDescending);
        Assert.Equal([new ViewSort("due", true), new ViewSort("title", false)], view.Sorts);
    }

    [Fact]
    public void Reading_without_a_sort_list_keeps_the_single_key_fields()
    {
        const string json = """
            {"views":[{"id":"v1","name":"All","kind":"list","sortBy":"title","sortDescending":true}]}
            """;

        var view = ViewDefinitionsJson.Read(json).Views.Single();

        Assert.Equal("title", view.SortBy);
        Assert.True(view.SortDescending);
        Assert.True(view.Sorts.IsDefaultOrEmpty);
    }

    [Fact]
    public void Without_a_sort_list_the_single_key_fields_stand_as_before()
    {
        var view = List() with { SortBy = "title", SortDescending = true };

        Assert.Same(view, ViewSorting.MirrorPrimary(view));
    }
}
