using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.ObjectStorage;

/// <summary>One expired operation discovered without bypassing RLS in application code.</summary>
public sealed record AbandonedObjectOperation(
    string OwnerKind,
    Guid OwnerId,
    Guid TenantId,
    Guid WorkspaceId,
    Guid ActorId,
    DateTimeOffset ExpiresAt);

/// <summary>Calls the exact security-definer discovery function for abandoned object owners.</summary>
public sealed class AbandonedObjectOperationStore(NpgsqlDataSource dataSource)
{
    private const string FindSql = "SELECT * FROM nix_find_abandoned_object_operations(@limit)";

    public async ValueTask<IReadOnlyList<AbandonedObjectOperation>> FindAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var results = new List<AbandonedObjectOperation>(limit);
        var command = dataSource.CreateCommand(FindSql);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer)
            {
                TypedValue = limit,
            });
            var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    results.Add(new AbandonedObjectOperation(
                        reader.GetString(0),
                        reader.GetGuid(1),
                        reader.GetGuid(2),
                        reader.GetGuid(3),
                        reader.GetGuid(4),
                        await reader.GetFieldValueAsync<DateTimeOffset>(5, cancellationToken)
                            .ConfigureAwait(false)));
                }
            }
        }
        return results;
    }
}
