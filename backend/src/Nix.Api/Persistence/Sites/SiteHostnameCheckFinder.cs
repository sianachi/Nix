using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sites;

/// <summary>
/// Calls <c>nix_site_hostname_checks</c> straight on the pool with no session context, as the
/// rebuild finder does: the function crosses tenants only because its migrator owner bypasses RLS,
/// and it returns identifiers, hostnames and instants only.
/// </summary>
public sealed class SiteHostnameCheckFinder(NpgsqlDataSource dataSource) : ISiteHostnameCheckCandidates
{
    /// <inheritdoc />
    public async Task<IReadOnlyList<SiteHostnameCheckCandidate>> FindAsync(int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var found = new List<SiteHostnameCheckCandidate>(limit);
        var command = dataSource.CreateCommand("SELECT * FROM nix_site_hostname_checks(@limit)");
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    found.Add(new SiteHostnameCheckCandidate(
                        TenantId.From(reader.GetGuid(0)),
                        WorkspaceId.From(reader.GetGuid(1)),
                        reader.GetGuid(2),
                        PrincipalId.From(reader.GetGuid(3)),
                        reader.GetString(4),
                        await reader.GetFieldValueAsync<DateTimeOffset>(5, cancellationToken).ConfigureAwait(false),
                        await reader.IsDBNullAsync(6, cancellationToken).ConfigureAwait(false) ? null : await reader.GetFieldValueAsync<DateTimeOffset>(6, cancellationToken).ConfigureAwait(false),
                        await reader.IsDBNullAsync(7, cancellationToken).ConfigureAwait(false) ? null : await reader.GetFieldValueAsync<DateTimeOffset>(7, cancellationToken).ConfigureAwait(false),
                        reader.GetInt32(8)));
                }
            }
        }

        return found;
    }
}
