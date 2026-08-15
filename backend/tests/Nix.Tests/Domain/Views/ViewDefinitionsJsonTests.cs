using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

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
            // A non-null Mode on purpose: a fixture that left every optional field null would let
            // the reader drop them both and still pass.
            new ViewDefinition(
                "v3",
                "This month",
                ViewKind.Calendar,
                [],
                null,
                [],
                "due",
                "due",
                false,
                Mode: "week"),
            new ViewDefinition(
                "v4",
                "Covers",
                ViewKind.Gallery,
                ["title"],
                null,
                [],
                null,
                null,
                false,
                Mode: null,
                CoverProperty: "cover",
                EndDateProperty: null,
                CardSize: "large"),
            new ViewDefinition(
                "v5",
                "Delivery",
                ViewKind.Timeline,
                [],
                null,
                [],
                "starts",
                null,
                false,
                Mode: "quarter",
                CoverProperty: null,
                EndDateProperty: "ends"),
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
        Assert.False(entry.ContainsKey("coverProperty"));
        Assert.False(entry.ContainsKey("endDateProperty"));
        Assert.False(entry.ContainsKey("mode"));
        Assert.False(entry.ContainsKey("cardSize"));
        Assert.Equal("list", (string?)entry["kind"]);
    }

    [Fact]
    public void A_timeline_stores_both_ends_of_its_span()
    {
        // The start is stored under `dateProperty` and not under a name of the timeline's own. That
        // is what makes switching a view between calendar and timeline lossless: the same key means
        // the same thing to both, so the calendar keeps placing items after the switch back.
        var timeline = new ViewDefinition(
            "v1",
            "Delivery",
            ViewKind.Timeline,
            [],
            null,
            [],
            "starts",
            null,
            false,
            Mode: null,
            CoverProperty: null,
            EndDateProperty: "ends");

        var written = Assert.IsType<JsonObject>(JsonNode.Parse(ViewDefinitionsJson.Write([timeline])!));
        var entry = Assert.IsType<JsonObject>(Assert.IsType<JsonArray>(written["views"])[0]);

        Assert.Equal("timeline", (string?)entry["kind"]);
        Assert.Equal("starts", (string?)entry["dateProperty"]);
        Assert.Equal("ends", (string?)entry["endDateProperty"]);
        Assert.False(entry.ContainsKey("coverProperty"));
    }

    [Fact]
    public void A_timeline_that_names_no_end_date_property_is_read_and_kept()
    {
        // Every item on it is a milestone, which is a shape the view draws rather than a
        // configuration it is missing. Dropping the view as incomplete would take a working timeline
        // off the switcher.
        var read = ReadViews(
            """{"views":[{"id":"v1","name":"Delivery","kind":"timeline","dateProperty":"starts"}]}""");

        var timeline = Assert.Single(read);

        Assert.Equal(ViewKind.Timeline, timeline.Kind);
        Assert.Equal("starts", timeline.DateProperty);
        Assert.Null(timeline.EndDateProperty);
    }

    [Fact]
    public void A_gallery_stores_its_cover_property_and_omits_the_fields_it_left_unset()
    {
        // Named for what it checks. `Write` has no per-kind filtering - every field is written when
        // it is not null - so the absences below follow from the nulls this fixture passes and not
        // from any rule about galleries. Claiming the stronger property in the name would describe
        // behaviour the writer does not have.
        var gallery = new ViewDefinition(
            "v1",
            "Covers",
            ViewKind.Gallery,
            [],
            null,
            [],
            null,
            null,
            false,
            Mode: null,
            CoverProperty: "cover");

        var written = Assert.IsType<JsonObject>(JsonNode.Parse(ViewDefinitionsJson.Write([gallery])!));
        var entry = Assert.IsType<JsonObject>(Assert.IsType<JsonArray>(written["views"])[0]);

        Assert.Equal("gallery", (string?)entry["kind"]);
        Assert.Equal("cover", (string?)entry["coverProperty"]);
        Assert.False(entry.ContainsKey("groupBy"));
        Assert.False(entry.ContainsKey("dateProperty"));
        Assert.False(entry.ContainsKey("mode"));
    }

    [Fact]
    public void A_gallery_that_names_no_card_size_is_read_and_kept()
    {
        // Every gallery stored before the field existed, and every one whose author never touched
        // the size. Null is what the renderer draws as medium; the reader does not spell that out.
        var read = ReadViews("""{"views":[{"id":"v1","name":"Covers","kind":"gallery"}]}""");

        Assert.Null(Assert.Single(read).CardSize);
    }

    [Theory]
    [InlineData("huge")]
    [InlineData("Medium")]
    [InlineData("")]
    [InlineData("md")]
    public void A_card_size_this_build_does_not_define_reads_as_no_size_at_all(string size)
    {
        // The write path refuses these, so one in the column came from some other writer. It costs
        // the size and never the view: the gallery draws at medium, with every card still on
        // screen, rather than a token no renderer has a meaning for travelling any further. The
        // near-misses matter - "Medium" is the right word in the wrong case, and the set is closed
        // and lowercase on the wire.
        var read = ReadViews(
            $$"""{"views":[{"id":"v1","name":"Covers","kind":"gallery","cardSize":"{{size}}"}]}""");

        var gallery = Assert.Single(read);

        Assert.Equal(ViewKind.Gallery, gallery.Kind);
        Assert.Null(gallery.CardSize);
    }

    [Theory]
    [InlineData("small")]
    [InlineData("medium")]
    [InlineData("large")]
    public void Every_card_size_this_build_defines_survives_being_written_and_read_back(string size)
    {
        var gallery = new ViewDefinition(
            "v1",
            "Covers",
            ViewKind.Gallery,
            [],
            null,
            [],
            null,
            null,
            false,
            Mode: null,
            CoverProperty: null,
            EndDateProperty: null,
            CardSize: size);

        Assert.Equal(size, Assert.Single(ReadViews(ViewDefinitionsJson.Write([gallery]))).CardSize);
    }

    [Fact]
    public void A_gallery_that_names_no_cover_property_is_read_and_kept()
    {
        // The default state of every gallery anybody makes, so it has to survive the column rather
        // than be dropped as incomplete. There is nothing missing: the cards have titles.
        var read = ReadViews("""{"views":[{"id":"v1","name":"Covers","kind":"gallery"}]}""");

        var gallery = Assert.Single(read);

        Assert.Equal(ViewKind.Gallery, gallery.Kind);
        Assert.Null(gallery.CoverProperty);
    }

    [Fact]
    public void A_view_whose_kind_this_build_does_not_know_is_dropped_and_the_others_kept()
    {
        // A newer build adds "swimlane" and a person configures one. This instance offers the other
        // two views rather than refusing the container's switcher entirely.
        //
        // The fixture used to be "timeline", which stopped testing anything the day the timeline
        // shipped - the same trap `A_kind_this_build_does_not_know_is_not_a_kind` names about
        // "gallery". So this one has to be a word no build will have, not the next kind on the plan.
        var read = ReadViews(
            """
            {"views":[
              {"id":"v1","kind":"list"},
              {"id":"v2","kind":"swimlane"},
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

        // Both added here at once. A member-by-member comparison silently stops covering the round
        // trip for anything it does not name, so a per-kind field left out looks tested and is not
        // - which is exactly what had happened to Mode: it had no round-trip assertion anywhere in
        // the suite, only two checks that a list does *not* store it. Writing the rule down for
        // CoverProperty and leaving the field above it uncovered would have been worse than
        // neither.
        Assert.Equal(expected.Mode, actual.Mode);
        Assert.Equal(expected.CoverProperty, actual.CoverProperty);
        Assert.Equal(expected.EndDateProperty, actual.EndDateProperty);
        Assert.Equal(expected.CardSize, actual.CardSize);
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

    [Fact]
    public void A_query_view_stores_its_filters_and_reads_them_back()
    {
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition(
                "overdue",
                "Overdue",
                ViewKind.Query,
                [],
                null,
                [],
                null,
                null,
                false,
                Filters:
                [
                    new FilterRule("due", "before", "today"),
                    new FilterRule("done", "not-equals", "true"),
                ]),
        ];

        var read = ReadViews(ViewDefinitionsJson.Write(views));

        var view = Assert.Single(read);
        Assert.Equal(2, view.Filters.Length);
        Assert.Equal(new FilterRule("due", "before", "today"), view.Filters[0]);
        Assert.Equal(new FilterRule("done", "not-equals", "true"), view.Filters[1]);
    }

    [Fact]
    public void A_view_with_no_filters_stores_no_filters_key_at_all()
    {
        // The same null-guard shape as every other per-kind field: absent, never an explicit
        // empty, so a later reader never has to tell the two apart.
        ImmutableArray<ViewDefinition> views =
        [
            new ViewDefinition("all", "All", ViewKind.Query, [], null, [], null, null, false),
        ];

        var written = Assert.IsType<JsonObject>(JsonNode.Parse(ViewDefinitionsJson.Write(views)!));
        var entry = Assert.IsType<JsonObject>(written["views"]![0]);

        Assert.False(entry.ContainsKey("filters"));
        Assert.True(ReadViews(written.ToJsonString())[0].Filters.IsEmpty);
    }

    [Fact]
    public void A_malformed_filter_entry_is_dropped_without_costing_the_view()
    {
        // Fail-soft here, fail-closed at execution: a dropped rule can only widen a query, so the
        // endpoint re-validates the surviving set and refuses to run one that no longer passes.
        // This asserts the reader's half of that pair.
        var read = ReadViews(
            """
            {"views":[{"id":"v1","name":"Q","kind":"query","filters":[
                {"property":"due","operator":"before","value":"today"},
                {"property":"","operator":"equals","value":"x"},
                "not an object",
                {"property":"status"}
            ]}]}
            """);

        var view = Assert.Single(read);
        var rule = Assert.Single(view.Filters);
        Assert.Equal(new FilterRule("due", "before", "today"), rule);
    }
}
