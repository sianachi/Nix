using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Query;

/// <summary>
/// Runs a saved query in one statement, filtered by what the caller may see while it runs.
/// </summary>
/// <remarks>
/// <para>
/// The readable workspaces arrive as an array parameter, so the planner evaluates the permission
/// predicate beside the tenant one - <see cref="Calendar.WorkspaceCalendarReader"/>'s rule,
/// because a cross-container query is bulk disclosure and a limit spent on unreadable rows would
/// make a full list come back looking empty.
/// </para>
/// <para>
/// Truncation is detected by asking for one row more than the ceiling: the extra row is dropped
/// and its existence is the flag. Cheaper than a count, and exact.
/// </para>
/// </remarks>
public sealed class ItemQueryReader : IItemQuery
{
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes a new instance of the <see cref="ItemQueryReader"/> class.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="session">The tenant this request runs as.</param>
    public ItemQueryReader(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _sql = sql;
        _session = session;
    }

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A query runs on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<QueryResults> RunAsync(
        ItemId queryItemId,
        ImmutableArray<FilterRule> rules,
        QueryOrder order,
        DateOnly today,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(order);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who may read nowhere matches nothing. Returning early keeps that a fact
            // about their membership rather than a round trip that was always going to be empty.
            return QueryResults.Empty;
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var compiled = QuerySql.Compile(rules, order, today);

        var parameters = new List<NpgsqlParameter>(compiled.Parameters.Count + 4);
        parameters.AddRange(compiled.Parameters);
        parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value });
        parameters.Add(new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers });
        parameters.Add(new NpgsqlParameter("query_item_id", NpgsqlDbType.Uuid) { Value = queryItemId.Value });

        // One more than the ceiling: the extra row is the truncation flag, and is never returned.
        parameters.Add(new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit + 1 });

        var rows = _sql.QueryAsync<QueryRow, QueryRowMapper>(
            compiled.Sql,
            default,
            [.. parameters],
            cancellationToken);

        var items = new List<QueryResultItem>();
        var truncated = false;

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (items.Count == limit)
            {
                truncated = true;
                break;
            }

            items.Add(new QueryResultItem(
                ItemId.From(row.Id),
                WorkspaceId.From(row.WorkspaceId),
                row.ParentId is { } parent ? ItemId.From(parent) : null,
                row.ContainerTitle,
                row.Title,
                row.Type,
                row.Properties));
        }

        return new QueryResults(items, truncated);
    }

    /// <summary>One row of the compiled statement.</summary>
    /// <remarks>A struct, so streaming allocates only the records that survive into the result.</remarks>
    private readonly record struct QueryRow(
        Guid Id,
        Guid WorkspaceId,
        Guid? ParentId,
        string? ContainerTitle,
        string? Title,
        string Type,
        string? Properties);

    /// <summary>Reads the statement's columns, left to right for sequential access.</summary>
    private readonly struct QueryRowMapper : INixRowMapper<QueryRow>
    {
        /// <inheritdoc />
        public QueryRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var id = reader.GetGuid(0);
            var workspaceId = reader.GetGuid(1);
            var parentId = reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2);
            var containerTitle = reader.IsDBNull(3) ? null : reader.GetString(3);
            var title = reader.IsDBNull(4) ? null : reader.GetString(4);
            var type = reader.GetString(5);
            var properties = reader.IsDBNull(6) ? null : reader.GetString(6);

            return new QueryRow(id, workspaceId, parentId, containerTitle, title, type, properties);
        }
    }
}
