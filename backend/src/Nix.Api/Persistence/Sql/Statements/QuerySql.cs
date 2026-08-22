using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Views;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Compiles a query view's rules into one statement: every readable, active item whose property
/// bag satisfies the rules, with its parent's title riding along.
/// </summary>
/// <remarks>
/// <para>
/// <b>No user-controlled text ever enters the SQL.</b> The operator selects one of six fixed
/// fragment templates - an operator outside the closed set throws, because the handler re-validates
/// before calling and an unknown one here is a bug, not an input. Property keys and values are
/// parameters; the only interpolation is the parameter <em>name</em>, generated from the loop
/// index. A property-based test asserts arbitrary keys and values never appear in the emitted
/// text.
/// </para>
/// <para>
/// <b>The permission filter is a predicate in the statement</b>, the <see cref="GraphSql"/> /
/// <see cref="CalendarSql"/> rule: the readable workspaces arrive as an array parameter resolved
/// by the handler, never sent by a client, so the LIMIT is spent only on rows the caller may see.
/// The parent join carries the same readable-workspaces predicate as the row itself: the parent's
/// title is projected, and a cross-workspace parent - impossible today, but held only by caller
/// convention, not by any constraint - must surface as a null container title, never as a name
/// from a workspace the caller cannot read.
/// </para>
/// <para>
/// <b>Days compare the first ten characters, and must not cast</b> - <see cref="CalendarSql"/>'s
/// receipt: a stored <c>date</c> is <c>yyyy-MM-dd</c> and a stored <c>timestamp</c> is RFC 9557
/// with a bracketed zone, both beginning with the same ten characters, and a
/// <c>timestamptz</c> cast throws on the bracketed suffix. <c>left(NULL, 10)</c> is null, so an
/// item without the property fails every day comparison - absent is never "on" any day.
/// </para>
/// <para>
/// <b>Day rules over the reserved <c>due_date</c> key compile to <c>item.due_day</c></b> - the
/// stored generated column - and everything else stays a bag read with no index claimed. The
/// reason is row security: <c>-&gt;&gt;</c> and <c>left()</c> are not leakproof, so a predicate
/// over them can never be an index condition under RLS - measured on a 100k corpus as the runtime
/// role, the same query against the same expression index ran 0.5 ms with RLS bypassed and
/// 58.5 ms with it enforced. The same measurement retired the escape hatch this paragraph used to
/// record (an <c>@&gt;</c> arm over a GIN <c>jsonb_path_ops</c> index): <c>jsonb_contains</c> is
/// not leakproof either, so the planner never touched the GIN and the arm ran slower than the seq
/// scan it was meant to replace. A plain column is leakproof, which is why <c>due_day</c> exists;
/// with it, Overdue runs 4.9 ms / 1,026 buffers against a 99.7 ms / 5,527 seq-scan baseline, sort
/// node gone. The figures are the one-off design measurement's; the standing CI check is
/// <c>TaskSemanticsPlanEvidenceTests</c>, which asserts the planner's choice as the runtime role.
/// Any future index over the bag must clear the same bar.
/// </para>
/// <para>
/// <b>This compiler carries no <see cref="QueryOperators.Me"/>-handling branch, unlike
/// <see cref="QueryOperators.Today"/>'s <c>Day()</c>.</b> Not an omission: <c>Me</c> resolves to
/// the acting principal, which lives in the request's session context, and this is a static
/// class with nothing to read one from. <c>RunItemQueryHandler</c> resolves it and rewrites the
/// rule before calling the query port, so a value arriving here - even the literal text
/// <c>"me"</c>, which the injection property test exercises deliberately - is already ordinary
/// data and takes the exact same <c>EqualTo</c>/<c>NotEqualTo</c> path as any other equality: one
/// bound parameter, no special column or index.
/// </para>
/// </remarks>
public static class QuerySql
{
    /// <summary>
    /// Compiles the rules and the ordering.
    /// </summary>
    /// <param name="rules">Re-validated rules; an unknown operator throws.</param>
    /// <param name="order">How the rows are ordered.</param>
    /// <param name="today">The caller's today, resolving the <c>today</c> token and day windows.</param>
    /// <returns>The statement and its rule parameters.</returns>
    /// <remarks>
    /// The fixed parameters the statement also binds - <c>@tenant_id</c>, <c>@workspace_ids</c>,
    /// <c>@query_item_id</c>, <c>@limit</c> - are the reader's to supply; they are the same on
    /// every call and carry no per-rule shape.
    /// </remarks>
    public static CompiledQuery Compile(ImmutableArray<FilterRule> rules, QueryOrder order, DateOnly today)
    {
        ArgumentNullException.ThrowIfNull(order);

        var parameters = new List<NpgsqlParameter>();
        var sql = new StringBuilder(
            """
            SELECT item.id,
                   item.workspace_id,
                   item.parent_id,
                   parent.properties ->> 'title' AS container_title,
                   item.properties ->> 'title' AS title,
                   item.type,
                   item.properties::text AS properties,
                   item.last_modified_at
            FROM item
            LEFT JOIN item AS parent
                   ON parent.id = item.parent_id
                  AND parent.tenant_id = @tenant_id
                  AND parent.workspace_id = ANY(@workspace_ids)
                  AND parent.template_id IS NULL
                  AND parent.lifecycle_state = 'active'
            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND item.id <> @query_item_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS visibility_edge
                  LEFT JOIN LATERAL (
                      SELECT visibility_ancestor.template_id,
                             visibility_ancestor.lifecycle_state
                      FROM item AS visibility_ancestor
                      WHERE visibility_ancestor.tenant_id = @tenant_id
                        AND visibility_ancestor.id = visibility_edge.ancestor_id
                      LIMIT 1
                  ) AS stored_ancestor ON TRUE
                  WHERE visibility_edge.tenant_id = @tenant_id
                    AND visibility_edge.descendant_id = item.id
                    AND visibility_edge.depth > 0
                    AND (stored_ancestor.template_id IS NOT NULL
                         OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
                  OFFSET 0
              )
            """);

        if (!rules.IsDefaultOrEmpty)
        {
            for (var index = 0; index < rules.Length; index++)
            {
                AppendRule(sql, parameters, rules[index], index, today);
            }
        }

        AppendOrder(sql, parameters, order);
        sql.Append("\nLIMIT @limit");

        return new CompiledQuery(sql.ToString(), parameters);
    }

    /// <summary>
    /// The reserved key whose day comparisons compile to the generated column instead of the bag.
    /// </summary>
    /// <remarks>
    /// One key, matched by name: <c>item.due_day</c> is generated from exactly this key, so the
    /// two expressions are equal by construction and only the column form is index-servable under
    /// row security (see the class remarks). The name is interpolated as a fixed literal, never
    /// from input - the rule's key merely selects the branch.
    /// </remarks>
    private const string ReservedDueDateKey = "due_date";

    private static void AppendRule(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        FilterRule rule,
        int index,
        DateOnly today)
    {
        // A day expression over the reserved due-date key is the generated column; over any other
        // key it is the bag read. Same value by construction, different plan under RLS.
        var reservedDay = string.Equals(rule.Property, ReservedDueDateKey, StringComparison.Ordinal);

        // The only interpolated text besides the fixed column name: a parameter name generated
        // from the loop index. The key and every value reach the statement as bound parameters.
        string DayExpression() =>
            reservedDay
                ? "item.due_day"
                : $"left(item.properties ->> @{Text($"p{index}_key", rule.Property, parameters)}, 10)";

        switch (rule.Operator)
        {
            case QueryOperators.EqualTo:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND item.properties ->> @{Text($"p{index}_key", rule.Property, parameters)} = @{Text($"p{index}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.NotEqualTo:
                // IS DISTINCT FROM, so an absent property counts as "not equal" - Overdue's
                // done-not-equals-true must match an item that never had the property at all.
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND item.properties ->> @{Text($"p{index}_key", rule.Property, parameters)} IS DISTINCT FROM @{Text($"p{index}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.On:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND {DayExpression()} = @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.Before:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND {DayExpression()} < @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.OnOrAfter:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND {DayExpression()} >= @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.WithinNext:
                var days = int.Parse(rule.Value, NumberStyles.None, CultureInfo.InvariantCulture);
                var from = Text($"p{index}_from", Iso(today), parameters);
                var to = Text($"p{index}_to", Iso(today.AddDays(days)), parameters);
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND {DayExpression()} BETWEEN @{from} AND @{to}");
                break;

            default:
                throw new InvalidOperationException(
                    $"'{rule.Operator}' is not an operator this build compiles. The handler "
                    + "re-validates rules before running them, so reaching here is a bug rather "
                    + "than an input.");
        }
    }

    private static void AppendOrder(StringBuilder sql, List<NpgsqlParameter> parameters, QueryOrder order)
    {
        if (order.Key is null)
        {
            // Recency: what an unconfigured query view shows. Newest change first, because a
            // smart list with no date rule is a "what moved" list.
            sql.Append("\nORDER BY item.last_modified_at DESC, item.id");
            return;
        }

        var direction = order.Descending ? "DESC" : "ASC";

        // NULLS LAST in both directions: a column of blanks at the top tells nobody anything,
        // the same rule the client's own sort applies. Ordering by a property is lexical - a
        // number property sorts as text, which the contract states rather than hides.
        if (order.IsDay && string.Equals(order.Key, ReservedDueDateKey, StringComparison.Ordinal))
        {
            // The generated column, ascending by construction: the ascending index key IS the
            // order the starters want, and the sort node disappears only in that direction (the
            // trailing item.id is ASC either way). RunItemQuery never builds a descending day
            // order today; if that ever changes, this branch must not claim the index for it.
            sql.Append("\nORDER BY item.due_day ASC NULLS LAST, item.id");
        }
        else if (order.IsDay)
        {
            sql.Append(CultureInfo.InvariantCulture, $"\nORDER BY left(item.properties ->> @{Text("order_key", order.Key, parameters)}, 10) {direction} NULLS LAST, item.id");
        }
        else
        {
            sql.Append(CultureInfo.InvariantCulture, $"\nORDER BY item.properties ->> @{Text("order_key", order.Key, parameters)} {direction} NULLS LAST, item.id");
        }
    }

    private static string Text(string name, string value, List<NpgsqlParameter> parameters)
    {
        parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Text) { Value = value });
        return name;
    }

    private static string Day(string name, string value, DateOnly today, List<NpgsqlParameter> parameters)
    {
        var day = string.Equals(value, QueryOperators.Today, StringComparison.Ordinal)
            ? Iso(today)
            : value;
        return Text(name, day, parameters);
    }

    private static string Iso(DateOnly day) =>
        day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>A compiled statement and the rule parameters it binds.</summary>
/// <param name="Sql">The statement text.</param>
/// <param name="Parameters">The rule and ordering parameters; the caller adds the fixed ones.</param>
public sealed record CompiledQuery(string Sql, IReadOnlyList<NpgsqlParameter> Parameters);
