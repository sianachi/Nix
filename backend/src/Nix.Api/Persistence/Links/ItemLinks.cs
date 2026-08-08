using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Links;

/// <summary>
/// Reads <c>item_link</c>: the edges the collaboration service extracts when it materialises a
/// document.
/// </summary>
/// <remarks>
/// Read-only because the grant is. Core holds <c>SELECT</c> on this table and the collaboration
/// service holds the rest, so there is no write path here to leave out.
/// </remarks>
public sealed class ItemLinks : IItemLinks
{
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes a new instance of the <see cref="ItemLinks"/> class.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="session">The tenant this request runs as.</param>
    public ItemLinks(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _sql = sql;
        _session = session;
    }

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Backlinks are read on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Backlink>> BacklinksAsync(
        ItemId targetId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            return [];
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = _sql.QueryAsync<Backlink, BacklinkMapper>(
            SearchSql.ItemsLinkingTo,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("target_item_id", NpgsqlDbType.Uuid) { Value = targetId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
            ],
            cancellationToken);

        var backlinks = new List<Backlink>(limit);
        await foreach (var backlink in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            backlinks.Add(backlink);
        }

        return backlinks;
    }

    /// <summary>Reads a referring item and how often it refers.</summary>
    /// <remarks>A struct, so the query loop devirtualises and allocates nothing per row.</remarks>
    private readonly struct BacklinkMapper : INixRowMapper<Backlink>
    {
        /// <inheritdoc />
        public Backlink Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var source = new ItemDigest(
                ItemId.From(reader.GetGuid(0)),
                WorkspaceId.From(reader.GetGuid(1)),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3));

            return new Backlink(source, reader.GetInt32(4));
        }
    }
}
