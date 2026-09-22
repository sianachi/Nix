using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Search;

/// <summary>
/// Uses OpenSearch for ranked text queries while retaining authoritative Postgres resolution.
/// </summary>
public sealed class OpenSearchItemSearch : IItemSearch
{
    private readonly OpenSearchItemQueryClient _queries;
    private readonly ItemSearch _postgres;
    private readonly IItemLocks _locks;

    /// <summary>Initializes the feature-flagged search adapter.</summary>
    public OpenSearchItemSearch(OpenSearchItemQueryClient queries, ItemSearch postgres, IItemLocks locks)
    {
        ArgumentNullException.ThrowIfNull(queries);
        ArgumentNullException.ThrowIfNull(postgres);
        ArgumentNullException.ThrowIfNull(locks);

        _queries = queries;
        _postgres = postgres;
        _locks = locks;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        var candidates = await _queries
            .FindAsync(query, readableWorkspaces, limit, cancellationToken)
            .ConfigureAwait(false);
        if (candidates.Count == 0)
        {
            return [];
        }

        var identifiers = new ItemId[candidates.Count];
        for (var index = 0; index < candidates.Count; index++)
        {
            identifiers[index] = candidates[index].Id;
        }

        // OpenSearch filters before ranking, but it is derived and can lag a move, deletion, or
        // permission change. Resolve only the ranked candidate IDs through authoritative
        // Postgres/RLS, then retain the OpenSearch order while returning current metadata.
        var authoritative = await _postgres
            .ResolveAsync(identifiers, readableWorkspaces, cancellationToken)
            .ConfigureAwait(false);
        if (authoritative.Count == 0)
        {
            return [];
        }

        // The index drops a locked body once the worker handles the event locking it queued, but
        // until then - or indefinitely, if that event is stuck - it can still match on the body.
        // A locked item is kept only when its title matches, which is the one way the Postgres
        // search can reach it too.
        var lockedIds = new ItemId[authoritative.Count];
        for (var index = 0; index < authoritative.Count; index++)
        {
            lockedIds[index] = authoritative[index].Id;
        }

        var locked = await _locks.LockedAmongAsync(lockedIds, cancellationToken).ConfigureAwait(false);

        var currentById = new Dictionary<ItemId, ItemDigest>(authoritative.Count);
        for (var index = 0; index < authoritative.Count; index++)
        {
            var digest = authoritative[index];
            if (locked.Contains(digest.Id)
                && (digest.Title is null
                    || !digest.Title.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            currentById[digest.Id] = digest;
        }

        var results = new List<ItemDigest>(authoritative.Count);
        for (var index = 0; index < candidates.Count; index++)
        {
            if (currentById.TryGetValue(candidates[index].Id, out var current))
            {
                results.Add(current);
            }
        }

        return results;
    }

    /// <inheritdoc />
    public ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
        IReadOnlyList<ItemId> itemIds,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken) =>
        _postgres.ResolveAsync(itemIds, readableWorkspaces, cancellationToken);
}
