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
/// </para>
/// <para>
/// <b>Days compare the first ten characters, and must not cast</b> - <see cref="CalendarSql"/>'s
/// receipt: a stored <c>date</c> is <c>yyyy-MM-dd</c> and a stored <c>timestamp</c> is RFC 9557
/// with a bracketed zone, both beginning with the same ten characters, and a
/// <c>timestamptz</c> cast throws on the bracketed suffix. <c>left(NULL, 10)</c> is null, so an
/// item without the property fails every day comparison - absent is never "on" any day.
/// </para>
/// <para>
/// <b>No index is claimed.</b> The scan is bounded by <c>tenant_id</c> and the readable
/// workspaces (<c>IX_item_tenant_id_workspace_id</c>) with a top-N sort under the limit; at this
/// product's scale that is the honest default, and the EXPLAIN evidence attached to the change is
/// the measurement. The recorded escape hatch, only if measured slow: an <c>@&gt;</c> containment
/// arm for <c>equals</c> plus a GIN <c>jsonb_path_ops</c> index in a later goal's migration.
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
                  AND parent.template_id IS NULL
                  AND parent.lifecycle_state = 'active'
            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND item.id <> @query_item_id
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

    private static void AppendRule(
        StringBuilder sql,
        List<NpgsqlParameter> parameters,
        FilterRule rule,
        int index,
        DateOnly today)
    {
        // The only interpolated text: a name generated from the loop index. The key and every
        // value reach the statement as bound parameters.
        var key = Text($"p{index}_key", rule.Property, parameters);

        switch (rule.Operator)
        {
            case QueryOperators.EqualTo:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND item.properties ->> @{key} = @{Text($"p{index}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.NotEqualTo:
                // IS DISTINCT FROM, so an absent property counts as "not equal" - Overdue's
                // done-not-equals-true must match an item that never had the property at all.
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND item.properties ->> @{key} IS DISTINCT FROM @{Text($"p{index}_value", rule.Value, parameters)}");
                break;

            case QueryOperators.On:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND left(item.properties ->> @{key}, 10) = @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.Before:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND left(item.properties ->> @{key}, 10) < @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.OnOrAfter:
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND left(item.properties ->> @{key}, 10) >= @{Day($"p{index}_day", rule.Value, today, parameters)}");
                break;

            case QueryOperators.WithinNext:
                var days = int.Parse(rule.Value, NumberStyles.None, CultureInfo.InvariantCulture);
                var from = Text($"p{index}_from", Iso(today), parameters);
                var to = Text($"p{index}_to", Iso(today.AddDays(days)), parameters);
                sql.Append(CultureInfo.InvariantCulture, $"\n  AND left(item.properties ->> @{key}, 10) BETWEEN @{from} AND @{to}");
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

        var key = Text("order_key", order.Key, parameters);
        var direction = order.Descending ? "DESC" : "ASC";

        // NULLS LAST in both directions: a column of blanks at the top tells nobody anything,
        // the same rule the client's own sort applies. Ordering by a property is lexical - a
        // number property sorts as text, which the contract states rather than hides.
        if (order.IsDay)
        {
            sql.Append(CultureInfo.InvariantCulture, $"\nORDER BY left(item.properties ->> @{key}, 10) {direction} NULLS LAST, item.id");
        }
        else
        {
            sql.Append(CultureInfo.InvariantCulture, $"\nORDER BY item.properties ->> @{key} {direction} NULLS LAST, item.id");
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
