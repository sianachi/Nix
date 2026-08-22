using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Query;

/// <summary>
/// What the compiled query statement must say, asserted against its text - the same argument
/// <c>GraphStatementTests</c> makes: the predicate that keeps one workspace's rows out of another's
/// answer either appears in the statement or does not, and its absence still compiles, still runs,
/// and is a breach. Two tenants against real Postgres prove the behaviour in
/// <c>Nix.Integration.Tests</c>; this proves the shape without a Docker daemon.
/// </summary>
public sealed class QueryStatementTests
{
    private static readonly DateOnly Today = new(2026, 8, 15);

    private static CompiledQuery Compile(params FilterRule[] rules) =>
        QuerySql.Compile([.. rules], QueryOrder.Recency, Today);

    [Fact]
    public void The_statement_filters_by_the_workspaces_the_caller_may_read()
    {
        // Bound from IPermissionResolver, never from the request. Its absence is the whole breach.
        Assert.Contains(
            "item.workspace_id = ANY(@workspace_ids)",
            Compile().Sql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_statement_scopes_both_tables_it_reads_to_one_tenant()
    {
        var sql = Compile().Sql;

        Assert.Contains("item.tenant_id = @tenant_id", sql, StringComparison.Ordinal);
        // The parent join too: a missing tenant predicate there would let a title from another
        // tenant ride along as a container name.
        Assert.Contains("parent.tenant_id = @tenant_id", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_statement_reads_only_active_items_and_never_the_smart_list_itself()
    {
        var sql = Compile().Sql;

        Assert.Contains("item.lifecycle_state = 'active'", sql, StringComparison.Ordinal);
        Assert.Contains("item.id <> @query_item_id", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Day_comparisons_take_the_first_ten_characters_and_never_cast()
    {
        // A stored timestamp carries a bracketed zone Postgres will not parse; a timestamptz cast
        // would throw on every zoned value in the table. CalendarSql's receipt.
        var compiled = Compile(new FilterRule("due", "before", "today"));

        Assert.Contains("left(item.properties ->> @p0_key, 10) <", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("::timestamp", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("::date", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Day_rules_over_the_reserved_due_date_key_compile_to_the_generated_column()
    {
        // The column and the bag expression are equal by construction; only the column can be an
        // index condition under row security, which is the whole reason due_day exists. The key
        // must not travel as a parameter here - the branch selects a fixed literal.
        var compiled = Compile(new FilterRule("due_date", "before", "today"));

        Assert.Contains("item.due_day <", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("p0_key", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain(compiled.Parameters, parameter => parameter.ParameterName == "p0_key");
    }

    [Fact]
    public void Ordering_by_the_reserved_due_date_key_rides_the_generated_column_too()
    {
        // The ascending index key IS the order the starters want; ordering through the bag would
        // put a sort node back on top of an index-served scan.
        var compiled = QuerySql.Compile(
            [new FilterRule("due_date", "within-next", "7")],
            new QueryOrder("due_date", IsDay: true, Descending: false),
            Today);

        Assert.Contains("ORDER BY item.due_day ASC NULLS LAST", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("item.due_day BETWEEN", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_other_key_keeps_the_bag_expression_exactly_as_before()
    {
        // The reserved-key branch must not widen: a workspace's own `deadline` date property is
        // still a bag read, parameterised, and no generated column is named for it.
        var compiled = Compile(new FilterRule("deadline", "on", "today"));

        Assert.Contains("left(item.properties ->> @p0_key, 10) =", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("due_day", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_today_token_resolves_to_the_caller_day_as_a_parameter()
    {
        var compiled = Compile(new FilterRule("due", "before", "today"));

        var day = Assert.Single(compiled.Parameters, parameter => parameter.ParameterName == "p0_day");
        Assert.Equal("2026-08-15", day.Value);
    }

    [Fact]
    public void Within_next_compiles_to_a_window_from_today()
    {
        var compiled = Compile(new FilterRule("due", "within-next", "7"));

        Assert.Contains("BETWEEN @p0_from AND @p0_to", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("2026-08-15", Assert.Single(compiled.Parameters, p => p.ParameterName == "p0_from").Value);
        Assert.Equal("2026-08-22", Assert.Single(compiled.Parameters, p => p.ParameterName == "p0_to").Value);
    }

    [Fact]
    public void Not_equals_matches_absence_too()
    {
        // IS DISTINCT FROM, not <>: Overdue's done-not-equals-true must match an item that never
        // had the property at all.
        var compiled = Compile(new FilterRule("done", "not-equals", "true"));

        Assert.Contains("IS DISTINCT FROM", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_ordering_is_stable_whatever_orders_it()
    {
        Assert.Contains(
            "ORDER BY item.last_modified_at DESC, item.id",
            QuerySql.Compile([], QueryOrder.Recency, Today).Sql,
            StringComparison.Ordinal);

        Assert.Contains(
            "ORDER BY left(item.properties ->> @order_key, 10) ASC NULLS LAST, item.id",
            QuerySql.Compile([], new QueryOrder("due", IsDay: true, Descending: false), Today).Sql,
            StringComparison.Ordinal);

        Assert.Contains(
            "ORDER BY item.properties ->> @order_key DESC NULLS LAST, item.id",
            QuerySql.Compile([], new QueryOrder("status", IsDay: false, Descending: true), Today).Sql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void An_operator_outside_the_closed_set_is_a_bug_not_an_input()
    {
        // The handler re-validates before compiling, so an unknown operator reaching here throws
        // rather than being guessed at.
        Assert.Throws<InvalidOperationException>(() =>
            Compile(new FilterRule("due", "contains", "x")));
    }

    [Fact]
    public void No_key_or_value_anybody_types_ever_enters_the_statement_text()
    {
        // The injection guarantee, stated as a property over generated hostile inputs, across
        // EVERY operator - the day arms became key-dependent when the reserved due_date branch
        // arrived, so they are exactly the arms this property must hold over. The invariant is
        // deliberately the weaker, precise one: the emitted text is byte-identical for every key
        // EXCEPT the single reserved literal, because only parameter NAMES (and that one fixed
        // column name) are interpolated. Deterministically seeded, so a failure reproduces.
#pragma warning disable CA5394 // Justification: the randomness generates test inputs, not secrets; a seeded generator is the point, so a failure reproduces.
        var random = new Random(20260815);
        var alphabet = "abc'\";-- OR 1=1;DROP TABLE item;\\@{}$()%_\n\t";

        string Hostile(int length)
        {
            var characters = new char[length];
            for (var index = 0; index < length; index++)
            {
                characters[index] = alphabet[random.Next(alphabet.Length)];
            }

            return new string(characters);
        }

        var tame = Compile(
            new FilterRule("k", "equals", "v"),
            new FilterRule("k", "not-equals", "v"),
            new FilterRule("k", "on", "today"),
            new FilterRule("k", "before", "today"),
            new FilterRule("k", "on-or-after", "today"),
            new FilterRule("k", "within-next", "7"));

        for (var round = 0; round < 200; round++)
        {
            var key = Hostile(1 + random.Next(24));
            var value = Hostile(1 + random.Next(48));

            var compiled = Compile(
                new FilterRule(key, "equals", value),
                new FilterRule(key, "not-equals", value),
                new FilterRule(key, "on", "today"),
                new FilterRule(key, "before", "today"),
                new FilterRule(key, "on-or-after", "today"),
                new FilterRule(key, "within-next", "7"));

            Assert.Equal(tame.Sql, compiled.Sql);
            Assert.Equal(key, compiled.Parameters[0].Value);
            Assert.Equal(value, compiled.Parameters[1].Value);
        }
#pragma warning restore CA5394
    }

    [Theory]
    [InlineData("DUE_DATE")]
    [InlineData("Due_Date")]
    [InlineData("due_date ")]
    [InlineData(" due_date")]
    public void Only_the_exact_reserved_literal_selects_the_column_branch(string almost)
    {
        // Ordinal, exact, or nothing: a near-miss of the reserved key must stay a parameterised
        // bag read, because the branch's safety argument is that the interpolated column name is
        // a fixed literal selected by comparison, never derived from the input.
        var compiled = Compile(new FilterRule(almost, "before", "today"));

        Assert.Contains("left(item.properties ->> @p0_key, 10) <", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("due_day", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(almost, compiled.Parameters[0].Value);
    }
}
