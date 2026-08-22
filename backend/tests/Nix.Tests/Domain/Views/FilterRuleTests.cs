using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// The filter grammar: what a rule may say, refused per operator rather than per property type,
/// because a cross-container query has no single schema to check a key against.
/// </summary>
public sealed class FilterRuleTests
{
    [Theory]
    [InlineData("equals")]
    [InlineData("not-equals")]
    [InlineData("on")]
    [InlineData("before")]
    [InlineData("on-or-after")]
    [InlineData("within-next")]
    public void Every_operator_the_contract_publishes_is_known(string @operator) =>
        Assert.True(QueryOperators.IsKnown(@operator));

    [Theory]
    [InlineData("contains")]
    [InlineData("EQUALS")]
    [InlineData("")]
    [InlineData("or")]
    public void An_operator_outside_the_closed_set_is_not_a_filter(string @operator)
    {
        Assert.False(QueryOperators.IsKnown(@operator));
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("due", @operator, "x")));
    }

    [Fact]
    public void A_literal_rule_with_a_property_and_a_value_is_storable()
    {
        Assert.Null(QueryOperators.Refuse(new FilterRule("status", "equals", "Doing")));
        Assert.Null(QueryOperators.Refuse(new FilterRule("done", "not-equals", "true")));
    }

    [Theory]
    [InlineData("on", "today")]
    [InlineData("before", "today")]
    [InlineData("on-or-after", "2026-08-15")]
    public void A_day_operator_takes_the_today_token_or_a_calendar_day(string @operator, string value) =>
        Assert.Null(QueryOperators.Refuse(new FilterRule("due", @operator, value)));

    [Theory]
    [InlineData("2026-13-45")]
    [InlineData("tomorrow")]
    [InlineData("2026/08/15")]
    public void A_day_operator_refuses_what_is_not_a_day(string value)
    {
        // A malformed day compares happily as text and would silently match nothing, which a
        // reader reads as "nothing is due" - so it is refused where somebody typed it.
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("due", "before", value)));
    }

    [Theory]
    [InlineData("1")]
    [InlineData("7")]
    [InlineData("365")]
    public void Within_next_takes_a_day_count_inside_the_bound(string value) =>
        Assert.Null(QueryOperators.Refuse(new FilterRule("due", "within-next", value)));

    [Theory]
    [InlineData("0")]
    [InlineData("366")]
    [InlineData("-3")]
    [InlineData("seven")]
    [InlineData("7.5")]
    public void Within_next_refuses_a_count_outside_the_bound_or_not_a_count(string value) =>
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("due", "within-next", value)));

    [Fact]
    public void A_rule_needs_a_property_and_a_value()
    {
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("", "equals", "x")));
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("status", "equals", "")));
    }

    [Fact]
    public void The_key_and_value_bounds_hold()
    {
        Assert.NotNull(QueryOperators.Refuse(
            new FilterRule(new string('k', QueryOperators.MaximumPropertyLength + 1), "equals", "x")));
        Assert.NotNull(QueryOperators.Refuse(
            new FilterRule("status", "equals", new string('v', QueryOperators.MaximumValueLength + 1))));

        Assert.Null(QueryOperators.Refuse(
            new FilterRule(new string('k', QueryOperators.MaximumPropertyLength), "equals", "x")));
    }

    [Fact]
    public void The_me_token_is_a_valid_value_for_either_equality_operator()
    {
        Assert.Null(QueryOperators.Refuse(new FilterRule("assignee", "equals", QueryOperators.Me)));
        Assert.Null(QueryOperators.Refuse(new FilterRule("assignee", "not-equals", QueryOperators.Me)));
    }

    [Theory]
    [InlineData("on")]
    [InlineData("before")]
    [InlineData("on-or-after")]
    public void The_me_token_is_meaningless_to_a_day_operator_and_is_refused_by_the_day_grammar(string @operator)
    {
        // No bespoke "me is not a day" message - it is refused the exact way any other malformed
        // day is: it is neither `today` nor a calendar day.
        var reason = QueryOperators.Refuse(new FilterRule("assignee", @operator, QueryOperators.Me));

        Assert.NotNull(reason);
        Assert.Contains("reads a day", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void The_me_token_is_meaningless_to_within_next_and_is_refused_by_the_count_grammar()
    {
        var reason = QueryOperators.Refuse(new FilterRule("assignee", "within-next", QueryOperators.Me));

        Assert.NotNull(reason);
        Assert.Contains("reads a number of days", reason, StringComparison.Ordinal);
    }
}
