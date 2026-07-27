using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Core.Views;

namespace Nix.Core.Tests.Views;

/// <summary>
/// The seam between the <c>item.views</c> column and the switcher a person sees.
/// </summary>
/// <remarks>
/// <para>
/// Reading is total for a plainer reason than the schema reader's: a malformed view set costs a
/// container its switcher, and it must not cost the container its children. Everything a container
/// holds is still listable with no views at all, so every unreadable shape below has to come back
/// as a view set - possibly an empty one - and never as an exception on a listing request.
/// </para>
/// <para>
/// Writing an empty set stores nothing at all rather than an empty document, so a container that
/// offers no views leaves the column reading exactly as it did before anybody configured one. That
/// is what keeps "never configured" and "configured, then emptied" from being two states the rest
/// of the system has to tell apart.
/// </para>
/// </remarks>
public sealed class ViewDefinitionsJsonTests
{
    /// <summary>The views out of a parsed column, which is what most of these tests are about.</summary>
    private static ImmutableArray<ViewDefinition> ReadViews(string? json) =>
        ViewDefinitionsJson.Read(json).Views;


    [Fact]
    public void A_written_view_set_reads_back_as_the_one_that_was_written()
    {
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition("v1", "Everything", ViewKind.List, ["title", "status"], null, [], null, "title", false),
            new ViewDefinition("v2", "By stage", ViewKind.Board, [], "status", ["Todo", "Done"], null, null, true),
            new ViewDefinition("v3", "This month", ViewKind.Calendar, [], null, [], "due", "due", false),
        ];

        var read = ReadViews(ViewDefinitionsJson.Write(views));

        Assert.Equal(views.Length, read.Length);
        for (var index = 0; index < views.Length; index++)
        {
            AssertSameView(views[index], read[index]);
        }
    }

    [Fact]
    public void A_container_that_offers_no_views_stores_nothing_at_all()
    {
        Assert.Null(ViewDefinitionsJson.Write([]));
        Assert.Null(ViewDefinitionsJson.Write(default));
    }

    [Fact]
    public void A_written_view_leaves_out_the_fields_its_kind_has_no_use_for()
    {
        // Absent rather than null, so a stored board carries the board's configuration and nothing
        // else. It keeps the column small and keeps a reader from mistaking an explicit null for a
        // deliberate clearing of something.
        var list = new ViewDefinition("v1", "Everything", ViewKind.List, [], null, [], null, null, false);

        var written = Assert.IsType<JsonObject>(JsonNode.Parse(ViewDefinitionsJson.Write([list])!));
        var entry = Assert.IsType<JsonObject>(Assert.IsType<JsonArray>(written["views"])[0]);

        Assert.False(entry.ContainsKey("groupBy"));
        Assert.False(entry.ContainsKey("dateProperty"));
        Assert.False(entry.ContainsKey("sortBy"));
        Assert.False(entry.ContainsKey("columns"));
        Assert.False(entry.ContainsKey("groupOrder"));
        Assert.Equal("list", (string?)entry["kind"]);
    }

    [Fact]
    public void A_view_whose_kind_this_build_does_not_know_is_dropped_and_the_others_kept()
    {
        // A newer build adds "timeline" and a person configures one. This instance offers the other
        // two views rather than refusing the container's switcher entirely.
        var read = ReadViews(
            """
            {"views":[
              {"id":"v1","kind":"list"},
              {"id":"v2","kind":"timeline"},
              {"id":"v3","kind":"board","groupBy":"status"}
            ]}
            """);

        string[] expected = ["v1", "v3"];
        Assert.Equal(expected, Ids(read));
    }

    [Fact]
    public void The_first_of_two_views_sharing_an_id_wins()
    {
        // The id is what a shared link names, so two views answering to it is a link that means
        // two things. First wins for the same reason a duplicated property key does.
        var read = ReadViews(
            """
            {"views":[
              {"id":"v1","name":"First","kind":"list"},
              {"id":"v1","name":"Second","kind":"board","groupBy":"status"}
            ]}
            """);

        var view = Assert.Single(read);
        Assert.Equal("First", view.Name);
        Assert.Equal(ViewKind.List, view.Kind);
    }

    [Fact]
    public void A_view_with_no_usable_id_is_dropped()
    {
        var read = ReadViews(
            """
            {"views":[
              {"kind":"list"},
              {"id":"","kind":"list"},
              {"id":null,"kind":"list"},
              {"id":3,"kind":"list"},
              "v0",
              ["v0"],
              null,
              {"id":"kept","kind":"list"}
            ]}
            """);

        string[] expected = ["kept"];
        Assert.Equal(expected, Ids(read));
    }

    [Fact]
    public void A_view_missing_a_name_is_named_by_its_id()
    {
        // Better a switcher tab reading "v1" than a nameless one nobody can click with confidence.
        Assert.Equal("v1", Assert.Single(ReadViews("""{"views":[{"id":"v1","kind":"list"}]}""")).Name);
    }

    [Fact]
    public void A_column_named_twice_is_shown_once()
    {
        var read = ReadViews(
            """
            {"views":[{"id":"v1","kind":"list","columns":["title","status","title",7,null]}]}
            """);

        string[] expected = ["title", "status"];
        Assert.Equal(expected, Assert.Single(read).Columns.ToArray());
    }

    [Fact]
    public void A_view_keeps_only_the_per_kind_fields_it_could_actually_read()
    {
        // The per-kind fields are all optional and all independently malformable. A board whose
        // groupBy is a number reads as a board with no grouping property, which CanRender then
        // refuses - rather than a board that renders against a key nobody can have.
        var read = Assert.Single(ReadViews(
            """
            {"views":[{"id":"v1","kind":"board","groupBy":7,"groupOrder":"Todo",
                       "dateProperty":{},"sortBy":null,"sortDescending":"yes"}]}
            """));

        Assert.Null(read.GroupBy);
        Assert.Empty(read.GroupOrder);
        Assert.Null(read.DateProperty);
        Assert.Null(read.SortBy);
        Assert.False(read.SortDescending);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json at all")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("[{\"id\":\"v1\",\"kind\":\"list\"}]")]
    [InlineData("42")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"views\":{}}")]
    [InlineData("{\"views\":\"v1\"}")]
    public void Whatever_is_in_the_column_reads_as_a_view_set_rather_than_throwing(string? json)
    {
        Assert.Empty(ReadViews(json));
    }

    private static string[] Ids(ImmutableArray<ViewDefinition> views) =>
        [.. views.Select(view => view.Id)];

    private static void AssertSameView(ViewDefinition expected, ViewDefinition actual)
    {
        // Member by member: the generated record equality compares the two ImmutableArray members
        // by reference, so it would pass here for a reason that has nothing to do with the values.
        Assert.Equal(expected.Id, actual.Id);
        Assert.Equal(expected.Name, actual.Name);
        Assert.Equal(expected.Kind, actual.Kind);
        Assert.Equal(expected.Columns.ToArray(), actual.Columns.ToArray());
        Assert.Equal(expected.GroupBy, actual.GroupBy);
        Assert.Equal(expected.GroupOrder.ToArray(), actual.GroupOrder.ToArray());
        Assert.Equal(expected.DateProperty, actual.DateProperty);
        Assert.Equal(expected.SortBy, actual.SortBy);
        Assert.Equal(expected.SortDescending, actual.SortDescending);
    }

    [Fact]
    public void An_item_that_has_said_nothing_opens_on_its_document()
    {
        // The overwhelmingly common case: a note nobody has configured a view on. Absent has to
        // mean the body, or every plain note would open on something it does not have.
        Assert.Equal(ViewDefinitionsJson.DocumentView, ViewDefinitionsJson.Read(null).Resolve());
        Assert.Equal(ViewDefinitionsJson.DocumentView, ViewDefinitionsJson.Read("{}").Resolve());
    }

    [Fact]
    public void The_view_named_as_the_default_is_the_one_that_opens()
    {
        var stored = ViewDefinitionsJson.Read(
            """{"views":[{"id":"all","kind":"list"},{"id":"by-status","kind":"list"}],"default":"by-status"}""");

        Assert.Equal("by-status", stored.Resolve());
    }

    [Fact]
    public void A_default_naming_a_view_that_is_gone_opens_the_document_rather_than_a_survivor()
    {
        // Falling back to the first view would mean deleting a view silently promoted whichever
        // one happened to be first - a different item opening than anybody chose. The body is the
        // one answer that is never somebody else's view.
        var stored = ViewDefinitionsJson.Read(
            """{"views":[{"id":"all","kind":"list"}],"default":"deleted-one"}""");

        Assert.Equal(ViewDefinitionsJson.DocumentView, stored.Resolve());
    }

    [Fact]
    public void The_default_survives_a_round_trip()
    {
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false),
            new ViewDefinition("board", "Board", ViewKind.Board, [], "status", [], null, null, false),
        ];

        var read = ViewDefinitionsJson.Read(ViewDefinitionsJson.Write(views, "board"));

        Assert.Equal("board", read.Default);
        Assert.Equal("board", read.Resolve());
    }

    [Fact]
    public void A_default_naming_no_view_is_not_written_at_all()
    {
        // Storing a dangling id would resolve to the document on the next read anyway, so writing
        // it only leaves a value that looks like a choice and behaves like none.
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false),
        ];

        var written = Assert.IsType<JsonObject>(
            JsonNode.Parse(ViewDefinitionsJson.Write(views, "not-a-view")!));

        Assert.False(written.ContainsKey("default"));
    }

    [Fact]
    public void The_document_is_stored_as_absence_rather_than_as_a_second_spelling()
    {
        // Absent already means the body. Writing the word too would give the same state two
        // representations, and a later reader would have to know they are the same.
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false),
        ];

        var written = Assert.IsType<JsonObject>(
            JsonNode.Parse(ViewDefinitionsJson.Write(views, ViewDefinitionsJson.DocumentView)!));

        Assert.False(written.ContainsKey("default"));
    }
}
