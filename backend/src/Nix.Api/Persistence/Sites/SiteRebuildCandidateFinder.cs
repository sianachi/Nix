using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sites;

/// <summary>
/// Calls <c>nix_site_rebuild_candidates</c> directly against the connection pool, with no session
/// context: FORCE ROW LEVEL SECURITY binds even a table owner, and the function crosses tenants only
/// because the migrator role that owns it bypasses it. Same reasoning as the reminder finder.
/// </summary>
public sealed class SiteRebuildCandidateFinder(NpgsqlDataSource dataSource) : ISiteRebuildCandidates
{
    /// <inheritdoc />
    public async Task<IReadOnlyList<SiteRebuildCandidate>> FindAsync(
        DateTimeOffset notBefore, int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var found = new List<SiteRebuildCandidate>(limit);
        var command = dataSource.CreateCommand("SELECT * FROM nix_site_rebuild_candidates(@now, @limit)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<DateTimeOffset>("now", NpgsqlDbType.TimestampTz) { TypedValue = notBefore });
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    found.Add(new SiteRebuildCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        WorkspaceId.From(reader.GetGuid(1)),
                        reader.GetGuid(2),
                        PrincipalId.From(reader.GetGuid(3)),
                        await reader.GetFieldValueAsync<DateTimeOffset>(4, cancellationToken).ConfigureAwait(false),
                        await reader.GetFieldValueAsync<DateTimeOffset>(5, cancellationToken).ConfigureAwait(false),
                        reader.GetInt32(6)));
                }
            }
        }

        return found;
    }
}
