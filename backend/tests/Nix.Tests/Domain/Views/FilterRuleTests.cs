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
    [InlineData("contains")]
    [InlineData("not-contains")]
    [InlineData("greater-than")]
    [InlineData("less-than")]
    [InlineData("is-empty")]
    [InlineData("is-not-empty")]
    public void Every_operator_the_contract_publishes_is_known(string @operator) =>
        Assert.True(QueryOperators.IsKnown(@operator));

    [Theory]
    [InlineData("CONTAINS")]
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

    [Theory]
    [InlineData("12")]
    [InlineData("-3.5")]
    [InlineData("0")]
    public void A_numeric_comparison_takes_a_number(string value)
    {
        Assert.Null(QueryOperators.Refuse(new FilterRule("points", "greater-than", value)));
        Assert.Null(QueryOperators.Refuse(new FilterRule("points", "less-than", value)));
    }

    [Theory]
    [InlineData("twelve")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    public void A_numeric_comparison_refuses_what_is_not_a_finite_number(string value) =>
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("points", "greater-than", value)));

    [Fact]
    public void The_emptiness_pair_takes_no_value_and_refuses_one()
    {
        Assert.Null(QueryOperators.Refuse(new FilterRule("owner", "is-empty", "")));
        Assert.Null(QueryOperators.Refuse(new FilterRule("owner", "is-not-empty", "")));
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("owner", "is-empty", "x")));
    }

    [Fact]
    public void A_query_compiles_every_operator_the_grammar_defines()
    {
        Assert.Equal(QueryOperators.All, QueryOperators.CompiledByQuery);
        Assert.Contains(QueryOperators.WithinLast, QueryOperators.All);
    }

    [Theory]
    [InlineData("today", "2026-08-13")]
    [InlineData("start-of-week", "2026-08-10")]
    [InlineData("start-of-month", "2026-08-01")]
    [InlineData("same-day-last-week", "2026-08-06")]
    [InlineData("same-day-last-month", "2026-07-13")]
    [InlineData("2026-01-02", "2026-01-02")]
    public void Day_tokens_resolve_from_the_callers_today(string token, string expected)
    {
        // 2026-08-13 is a Thursday; weeks start on Monday, as the calendar draws them.
        var today = new DateOnly(2026, 8, 13);

        Assert.Equal(DateOnly.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), QueryOperators.ResolveDay(token, today));
        Assert.Null(QueryOperators.Refuse(new FilterRule("due", QueryOperators.Before, token)));
    }

    [Fact]
    public void Start_of_week_on_a_monday_is_that_monday_and_on_a_sunday_the_monday_before()
    {
        Assert.Equal(new DateOnly(2026, 8, 10), QueryOperators.ResolveDay(QueryOperators.StartOfWeek, new DateOnly(2026, 8, 10)));
        Assert.Equal(new DateOnly(2026, 8, 10), QueryOperators.ResolveDay(QueryOperators.StartOfWeek, new DateOnly(2026, 8, 16)));
    }

    [Fact]
    public void Same_day_last_month_clamps_to_the_shorter_month()
    {
        Assert.Equal(new DateOnly(2026, 2, 28), QueryOperators.ResolveDay(QueryOperators.SameDayLastMonth, new DateOnly(2026, 3, 31)));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("366")]
    [InlineData("-1")]
    [InlineData("week")]
    public void Within_last_reads_the_same_day_count_within_next_does(string value) =>
        Assert.NotNull(QueryOperators.Refuse(new FilterRule("due", QueryOperators.WithinLast, value)));

    [Theory]
    [InlineData("$type", "equals", "task", true)]
    [InlineData("$type", "contains", "task", false)]
    [InlineData("$inside", "equals", "7b7b7000-1111-4111-8111-7b7b70000001", true)]
    [InlineData("$inside", "equals", "not-an-id", false)]
    [InlineData("$created", "within-last", "7", true)]
    [InlineData("$modified", "on", "start-of-week", true)]
    [InlineData("$created", "equals", "2026-01-01", false)]
    [InlineData("$done", "equals", "true", true)]
    [InlineData("$done", "equals", "yes", false)]
    [InlineData("$tag", "equals", "urgent", false)]
    [InlineData("$anything", "equals", "x", false)]
    public void Structural_fields_take_only_their_own_operators_and_values(string field, string @operator, string value, bool storable) =>
        Assert.Equal(storable, QueryOperators.Refuse(new FilterRule(field, @operator, value)) is null);
}
