using System.Collections.Immutable;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// Whether a stored view can actually be drawn against the schema in force where it lives.
/// </summary>
/// <remarks>
/// <para>
/// A view names a property; a schema is edited somewhere else entirely, by somebody else. So a
/// board can find its grouping property deleted, or retyped to something with no bounded set of
/// values, and the honest answer is to say so. Rendering it anyway produces an empty board, which
/// a person reads as an empty folder - the interface would be lying about which of the two happened.
/// </para>
/// <para>
/// The kind names get the same treatment as the property type names, and for the same reason: they
/// are stored text, so they are a contract, and one this build does not recognise is dropped rather
/// than rendered as something else.
/// </para>
/// </remarks>
public sealed class ViewDefinitionTests
{
    [Fact]
    public void Every_kind_this_build_defines_survives_being_written_and_read_back()
    {
        foreach (var kind in Enum.GetValues<ViewKind>())
        {
            Assert.True(ViewKinds.TryParse(ViewKinds.ToText(kind), out var read));
            Assert.Equal(kind, read);
        }
    }

    [Theory]
    [InlineData(ViewKind.List, "list")]
    [InlineData(ViewKind.Board, "board")]
    [InlineData(ViewKind.Calendar, "calendar")]
    public void A_kind_is_stored_under_the_name_the_contract_publishes(ViewKind kind, string name)
    {
        Assert.Equal(name, ViewKinds.ToText(kind));
        Assert.True(ViewKinds.TryParse(name, out var parsed));
        Assert.Equal(kind, parsed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("List")]
    [InlineData("kanban")]
    [InlineData("gallery")]
    [InlineData("1")]
    public void A_kind_this_build_does_not_know_is_not_a_kind(string? name)
    {
        // Fails closed: a newer build's "timeline" leaves an older instance offering fewer views,
        // never rendering one it has no renderer for.
        Assert.False(ViewKinds.TryParse(name, out _));
    }

    [Fact]
    public void Writing_a_kind_the_enum_does_not_define_is_a_bug_rather_than_a_value()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ViewKinds.ToText((ViewKind)99));
    }

    [Fact]
    public void Every_kind_has_a_descriptor()
    {
        // The point of the descriptor table is that adding a view kind is one entry. This is what
        // makes that true rather than merely intended: add a member to the enum and forget the
        // table, and the kind has no text to be stored under, cannot be parsed back, and reports
        // itself unrenderable - three runtime failures that this turns into one failing test.
        foreach (var kind in Enum.GetValues<ViewKind>())
        {
            Assert.NotNull(ViewKinds.Find(kind));
        }

        Assert.Equal(Enum.GetValues<ViewKind>().Length, ViewKinds.All.Length);
    }

    [Fact]
    public void No_two_kinds_share_a_stored_name()
    {
        // Two entries with the same text would make TryParse pick whichever came first, so one
        // kind would silently become the other on the way back out of storage.
        var names = ViewKinds.All.Select(descriptor => descriptor.Text).ToList();

        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void A_kind_whose_requirement_names_a_field_reads_that_field()
    {
        // The requirement's Read is what both CanRender and the storability check use to find the
        // configured property. If it pointed at the wrong field, a board would validate against a
        // calendar's date and the failure would look like a schema problem.
        var board = new ViewDefinition("v1", "By status", ViewKind.Board, [], "status", [], null, null, false);
        var calendar = new ViewDefinition("v2", "When", ViewKind.Calendar, [], null, [], "due", null, false);

        Assert.Equal("status", ViewKinds.Find(ViewKind.Board)?.Requirement?.Read(board));
        Assert.Equal("due", ViewKinds.Find(ViewKind.Calendar)?.Requirement?.Read(calendar));
        Assert.Null(ViewKinds.Find(ViewKind.List)?.Requirement);
    }

    [Fact]
    public void A_list_renders_against_any_schema_at_all()
    {
        // With no columns configured it falls back to the effective schema, and with no schema it
        // still has titles to show. There is no arrangement of the two that leaves it with nothing.
        var list = new ViewDefinition("v1", "All", ViewKind.List, [], null, [], null, null, false);

        Assert.True(list.CanRender(PropertySchema.Empty));
        Assert.True(list.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_list_renders_even_when_its_configured_columns_no_longer_exist()
    {
        // Columns are a preference, not a requirement: a deleted property costs the list a column
        // and the rest of the rows are still worth showing.
        var list = new ViewDefinition("v1", "All", ViewKind.List, ["status", "gone"], null, [], null, null, false);

        Assert.True(list.CanRender(PropertySchema.Empty));
    }

    [Fact]
    public void A_board_renders_when_it_groups_by_a_single_select()
    {
        var board = Board("status");

        Assert.True(board.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_board_whose_grouping_property_was_deleted_cannot_render()
    {
        // The case the schema editor causes and the board author never sees: the property is gone,
        // so there are no columns to draw and nothing to drag a card between.
        var board = Board("status");

        Assert.False(board.CanRender(PropertySchema.Empty));
        Assert.False(board.CanRender(SchemaOf(Property("owner", PropertyType.Select))));
    }

    [Theory]
    [InlineData(PropertyType.Text)]
    [InlineData(PropertyType.Number)]
    [InlineData(PropertyType.MultiSelect)]
    [InlineData(PropertyType.Date)]
    [InlineData(PropertyType.Checkbox)]
    [InlineData(PropertyType.Url)]
    public void A_board_grouping_by_a_type_that_cannot_be_grouped_cannot_render(PropertyType type)
    {
        // Retyping a select to text is one edit in a schema panel and it is enough. Grouping by
        // free text would draw a column per distinct value; grouping by a multi-select would put
        // one card in several columns at once.
        Assert.False(Board("status").CanRender(SchemaOf(Property("status", type))));
    }

    [Fact]
    public void A_board_that_names_no_grouping_property_cannot_render()
    {
        // Stored views are one record for all three kinds, so a board with a null groupBy is a
        // shape the type system permits and this is where it is caught.
        var board = new ViewDefinition("v1", "Board", ViewKind.Board, [], null, [], null, null, false);

        Assert.False(board.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_calendar_renders_when_it_places_items_by_a_date()
    {
        Assert.True(Calendar("due").CanRender(SchemaOf(Property("due", PropertyType.Date))));
    }

    [Fact]
    public void A_calendar_whose_date_property_was_deleted_cannot_render()
    {
        Assert.False(Calendar("due").CanRender(PropertySchema.Empty));
    }

    [Theory]
    [InlineData(PropertyType.Text)]
    [InlineData(PropertyType.Number)]
    [InlineData(PropertyType.Select)]
    [InlineData(PropertyType.MultiSelect)]
    [InlineData(PropertyType.Checkbox)]
    [InlineData(PropertyType.Url)]
    public void A_calendar_placing_items_by_anything_but_a_date_cannot_render(PropertyType type)
    {
        // Text that happens to hold "2026-07-27" is not a date: nothing has checked it, so half the
        // items would have no square to sit in.
        Assert.False(Calendar("due").CanRender(SchemaOf(Property("due", type))));
    }

    [Fact]
    public void A_calendar_that_names_no_date_property_cannot_render()
    {
        var calendar = new ViewDefinition("v1", "Calendar", ViewKind.Calendar, [], null, [], null, null, false);

        Assert.False(calendar.CanRender(SchemaOf(Property("due", PropertyType.Date))));
    }

    [Fact]
    public void A_board_asks_about_its_grouping_property_and_a_calendar_about_its_date()
    {
        // The per-kind fields are all present on every view, and a view has to ignore the ones that
        // are not its own. A board with a stale dateProperty still renders; a calendar with a stale
        // groupBy still renders.
        var schema = SchemaOf(
            Property("status", PropertyType.Select),
            Property("due", PropertyType.Date));

        var board = new ViewDefinition("v1", "Board", ViewKind.Board, [], "status", [], "missing", null, false);
        var calendar = new ViewDefinition("v2", "Calendar", ViewKind.Calendar, [], "missing", [], "due", null, false);

        Assert.True(board.CanRender(schema));
        Assert.True(calendar.CanRender(schema));
    }

    private static ViewDefinition Board(string groupBy) =>
        new("v1", "Board", ViewKind.Board, [], groupBy, [], null, null, false);

    private static ViewDefinition Calendar(string dateProperty) =>
        new("v1", "Calendar", ViewKind.Calendar, [], null, [], dateProperty, null, false);

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Property(string key, PropertyType type) =>
        new(key, key, type, ImmutableArray<string>.Empty, Required: false);
}
