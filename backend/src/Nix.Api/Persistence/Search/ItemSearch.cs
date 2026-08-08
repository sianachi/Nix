using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Search;

/// <summary>
/// Finds items with Postgres's own text search: a trigram index over titles and a
/// <c>tsvector</c> over document text, joined in one statement.
/// </summary>
/// <remarks>
/// <para>
/// Both statements take the readable workspaces as an array parameter, so the permission filter is
/// evaluated by the planner alongside the tenant predicate rather than applied to rows after they
/// have been read, ranked and counted.
/// </para>
/// <para>
/// Results are materialised into a list rather than streamed, unlike most of what
/// <see cref="NixSqlExecutor"/> serves. The bound is the caller's <c>limit</c>, which is small by
/// construction - a palette shows twenty rows and a person reads about five - so the list is
/// tens of small records and never grows with the corpus.
/// </para>
/// </remarks>
public sealed class ItemSearch : IItemSearch
{
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes a new instance of the <see cref="ItemSearch"/> class.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="session">The tenant this request runs as.</param>
    public ItemSearch(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _sql = sql;
        _session = session;
    }

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A search runs on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who belongs to nowhere searches nothing. Returning early keeps that a
            // fact about their membership rather than a round trip that was always going to
            // return no rows.
            return [];
        }

        var rows = _sql.QueryAsync<ItemDigest, DigestMapper>(
            SearchSql.MatchingItems,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                UuidArray("workspace_ids", readableWorkspaces),
                new NpgsqlParameter("title_pattern", NpgsqlDbType.Text) { Value = ContainsPattern(query) },
                new NpgsqlParameter("query", NpgsqlDbType.Text) { Value = query },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
            ],
            cancellationToken);

        return await CollectAsync(rows, limit, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
        IReadOnlyList<ItemId> itemIds,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (itemIds.Count == 0 || readableWorkspaces.Count == 0)
        {
            return [];
        }

        var identifiers = new Guid[itemIds.Count];
        for (var index = 0; index < itemIds.Count; index++)
        {
            identifiers[index] = itemIds[index].Value;
        }

        var rows = _sql.QueryAsync<ItemDigest, DigestMapper>(
            SearchSql.ReadableItemsById,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                UuidArray("workspace_ids", readableWorkspaces),
            ],
            cancellationToken);

        return await CollectAsync(rows, itemIds.Count, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Wraps a person's words in a containment pattern, with the pattern's own metacharacters
    /// neutralised.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is not an injection guard - the value is bound as a parameter and could not be one.
    /// It is a correctness guard: <c>%</c> and <c>_</c> mean something to <c>ILIKE</c>, so
    /// somebody searching for a literal underscore in a filename would otherwise get every title
    /// with any character in that position, and somebody who typed a stray <c>%</c> would match
    /// every item in the tenant.
    /// </para>
    /// <para>
    /// The backslash is escaped first and deliberately. Doing it after the others would go back
    /// over the backslashes they just introduced and double them, so a search for <c>a_b</c> would
    /// come out looking for a literal backslash. The statement names <c>ESCAPE '\'</c> to match.
    /// </para>
    /// </remarks>
    internal static string ContainsPattern(string query) =>
        string.Concat(
            "%",
            query.Replace("\\", "\\\\", StringComparison.Ordinal)
                .Replace("%", "\\%", StringComparison.Ordinal)
                .Replace("_", "\\_", StringComparison.Ordinal),
            "%");

    private static async ValueTask<IReadOnlyList<ItemDigest>> CollectAsync(
        IAsyncEnumerable<ItemDigest> rows,
        int expected,
        CancellationToken cancellationToken)
    {
        var digests = new List<ItemDigest>(expected);
        await foreach (var digest in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            digests.Add(digest);
        }

        return digests;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter UuidArray(string name, IReadOnlyList<WorkspaceId> values)
    {
        var identifiers = new Guid[values.Count];
        for (var index = 0; index < values.Count; index++)
        {
            identifiers[index] = values[index].Value;
        }

        return new NpgsqlParameter(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers };
    }

    /// <summary>Reads the four columns every item listing projects.</summary>
    /// <remarks>
    /// A struct so the query loop devirtualises and allocates nothing per row beyond the record
    /// itself. The title is nullable in the database and stays nullable here: an item that has
    /// never been named is a real state, and inventing "Untitled" in the persistence layer would
    /// put a piece of user-facing copy where nothing can translate it.
    /// </remarks>
    private readonly struct DigestMapper : INixRowMapper<ItemDigest>
    {
        /// <inheritdoc />
        public ItemDigest Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new ItemDigest(
                ItemId.From(reader.GetGuid(0)),
                WorkspaceId.From(reader.GetGuid(1)),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3));
        }
    }
}
