using System.Text.Json.Nodes;
using Nix.Core.Items;

namespace Nix.Core.Tests.Items;

/// <summary>
/// Writing part of a property bag without disturbing the rest of it.
/// </summary>
/// <remarks>
/// <para>
/// The write half of the rule the validator states from the other side: a caller sets the
/// properties it is changing and knows nothing about the rest. A board that replaced the bag would
/// drop every property it does not display - which is most of them, including <c>title</c> - and
/// the loss would be silent, because nothing downstream can tell a property that was never set from
/// one that was dropped on the way through.
/// </para>
/// <para>
/// A merge that cannot be understood answers with nothing rather than with a guess. That is the one
/// case where the write path is stricter than the read path: an unreadable bag on the way out costs
/// one row its display, and an unreadable change on the way in would cost an item its properties.
/// </para>
/// </remarks>
public sealed class ItemPropertiesTests
{
    [Fact]
    public void A_change_merges_into_the_stored_bag_rather_than_replacing_it()
    {
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Quarterly plan","status":"Todo"}""",
            """{"status":"Doing"}"""));

        Assert.Equal("Doing", (string?)merged["status"]);
        Assert.Equal("Quarterly plan", (string?)merged["title"]);
    }

    [Fact]
    public void Keys_the_change_did_not_mention_come_through_exactly_as_they_were()
    {
        // Nested on purpose: a merge that rebuilt values rather than carrying them would show up
        // here first, and a multi-select or a future structured property is precisely the kind of
        // value a caller setting one text field has no idea it is holding.
        var merged = Parse(ItemProperties.Merge(
            """{"tags":["a","b"],"meta":{"origin":"import","depth":2},"title":"Notes"}""",
            """{"title":"Renamed"}"""));

        Assert.Equal("Renamed", (string?)merged["title"]);
        Assert.Equal("""["a","b"]""", merged["tags"]?.ToJsonString());
        Assert.Equal("""{"origin":"import","depth":2}""", merged["meta"]?.ToJsonString());
    }

    [Fact]
    public void An_explicit_null_removes_the_key_rather_than_storing_a_null()
    {
        // Null is what a client clearing a field sends. Keeping it would leave "set but empty" and
        // "not set" indistinguishable to everything downstream - including the required check,
        // which would then be satisfiable by clearing the field.
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes","due":"2026-07-27"}""",
            """{"due":null}"""));

        Assert.False(merged.ContainsKey("due"));
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void Clearing_a_property_that_was_never_set_is_not_an_error()
    {
        // A client that sends its whole form, nulls and all, is the normal case rather than a
        // malformed one.
        var merged = Parse(ItemProperties.Merge("""{"title":"Notes"}""", """{"due":null}"""));

        Assert.False(merged.ContainsKey("due"));
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void A_change_carrying_a_structured_value_stores_that_value_whole()
    {
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes"}""",
            """{"tags":["a","b"],"meta":{"origin":"import"}}"""));

        Assert.Equal("""["a","b"]""", merged["tags"]?.ToJsonString());
        Assert.Equal("""{"origin":"import"}""", merged["meta"]?.ToJsonString());
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void An_item_with_no_bag_yet_gets_one()
    {
        var merged = Parse(ItemProperties.Merge(null, """{"title":"Notes"}"""));

        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Theory]
    [InlineData("{oops")]
    [InlineData("[1,2,3]")]
    [InlineData("\"a bag\"")]
    [InlineData("")]
    [InlineData("   ")]
    public void A_stored_bag_that_cannot_be_read_is_treated_as_an_empty_one(string properties)
    {
        // The alternative is refusing the write, which would strand the item: nobody could rename
        // it until somebody repaired the column by hand. Starting fresh loses whatever was in there,
        // and whatever was in there was already unreadable to every other code path.
        var merged = Parse(ItemProperties.Merge(properties, """{"title":"Notes"}"""));

        Assert.Equal("Notes", (string?)merged["title"]);
        Assert.Single(merged);
    }

    [Theory]
    [InlineData("[1,2,3]")]
    [InlineData("\"title\"")]
    [InlineData("42")]
    [InlineData("null")]
    [InlineData("{oops")]
    [InlineData("")]
    public void A_change_that_is_not_a_JSON_map_merges_to_nothing_at_all(string changes)
    {
        // Answering with null rather than with the untouched bag: the caller asked for something
        // that cannot be applied, and the use case has to be able to tell that from a change that
        // happened to alter nothing.
        Assert.Null(ItemProperties.Merge("""{"title":"Notes"}""", changes));
    }

    [Fact]
    public void A_change_that_says_nothing_leaves_the_bag_as_it_was()
    {
        var merged = Parse(ItemProperties.Merge("""{"title":"Notes","status":"Todo"}""", "{}"));

        Assert.Equal("Notes", (string?)merged["title"]);
        Assert.Equal("Todo", (string?)merged["status"]);
    }

    [Fact]
    public void A_merge_leaves_a_key_the_schema_never_declared_where_it_found_it()
    {
        // The other side of ADR-0007 section 4. The validator declines to report an undeclared key;
        // this is what makes that promise worth anything, because a merge that dropped what no
        // schema declares would delete the value the validator agreed to leave alone.
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes","retired":{"kept":true}}""",
            """{"title":"Renamed"}"""));

        Assert.Equal("""{"kept":true}""", merged["retired"]?.ToJsonString());
    }

    private static JsonObject Parse(string? merged)
    {
        Assert.NotNull(merged);
        return Assert.IsType<JsonObject>(JsonNode.Parse(merged));
    }
}
