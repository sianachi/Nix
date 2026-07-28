using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Items;

/// <summary>
/// The item tree over Postgres: EF Core for the envelope rows, hand-written SQL for the closure.
/// </summary>
/// <remarks>
/// <para>
/// The split follows the data-access rule. An item row is envelope CRUD and LINQ expresses it
/// perfectly well; closure maintenance is three set operations whose plans have to be legible, and
/// an expression tree between the author and those plans helps nobody. Both run on the same
/// connection and the same transaction - <see cref="NixSqlExecutor"/> borrows the context's - so
/// there is one unit of work and one <c>SET LOCAL</c> tenant scope covering both.
/// </para>
/// <para>
/// <b>Nothing here filters by tenant explicitly, and everything is tenant-scoped anyway.</b> The
/// row-level security policies do it, from the session context the request pipeline established.
/// The SQL statements additionally bind <c>@tenant_id</c> - not because the policy might fail, but
/// because a predicate the planner can see lets it use an index instead of evaluating the policy
/// per row, and because the security model asks for the assertion as defence in depth.
/// </para>
/// </remarks>
public sealed class ItemTree : IItemTree
{
    private readonly NixDbContext _dbContext;
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>
    /// Initializes a new instance of the <see cref="ItemTree"/> class.
    /// </summary>
    /// <param name="dbContext">The context owning the connection and transaction.</param>
    /// <param name="sql">The executor for the closure statements.</param>
    /// <param name="session">The tenant scope this unit of work runs under.</param>
    public ItemTree(
        NixDbContext dbContext,
        NixSqlExecutor sql,
        INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(dbContext);
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _dbContext = dbContext;
        _sql = sql;
        _session = session;
    }

    private TenantId Tenant => _session.Current?.TenantId
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Every item operation "
            + "is tenant-scoped and there is no unscoped path.");

    /// <inheritdoc />
    public async ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
        await _dbContext.Items
            .FirstOrDefaultAsync(item => item.Id == id, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(parents);

        if (parents.Count == 0)
        {
            return new HashSet<ItemId>();
        }

        // Hand-written, and see TreeShapeSql for the plan that decided it: the LINQ spelling reads
        // every child of every parent and deduplicates, so its cost grows with how full the
        // containers are rather than with how many were asked about.
        var ids = new Guid[parents.Count];
        for (var index = 0; index < parents.Count; index++)
        {
            ids[index] = parents[index].Value;
        }

        var found = new HashSet<ItemId>(parents.Count);

        var rows = _sql.QueryAsync<Guid, ItemIdMapper>(
            TreeShapeSql.ParentsWithChildren,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidArray("parent_ids", ids),
            ],
            cancellationToken);

        await foreach (var id in rows.ConfigureAwait(false))
        {
            found.Add(ItemId.From(id));
        }

        return found;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSeq,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = _dbContext.Items
            .Where(item => item.WorkspaceId == workspaceId && item.ParentId == parentId);

        if (!includeDeleted)
        {
            query = query.Where(item => item.LifecycleState == ItemLifecycleState.Active);
        }

        if (afterSeq is { } cursor)
        {
            query = query.Where(item => item.Seq > cursor);
        }

        return await query
            .OrderBy(item => item.Seq)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> WorkspaceExistsAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        await _dbContext.Workspaces
            .AnyAsync(workspace => workspace.Id == workspaceId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<long> NextSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken) =>
        await _sql.ScalarOrDefaultAsync<long>(
            ClosureSql.NextSiblingSequence,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                NullableUuid("parent_id", parentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<long> AllocateSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken)
    {
        var slot = await SlotAsync(workspaceId, parentId, movingId, afterId, cancellationToken)
            .ConfigureAwait(false);
        if (slot > 0)
        {
            return slot;
        }

        // No room between the neighbours. Spread this parent's children back out and ask once
        // more; the renumber preserves their order, so nobody reading the list sees anything move.
        await _sql.ExecuteAsync(
            ClosureSql.RenumberSiblings,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                NullableUuid("parent_id", parentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        slot = await SlotAsync(workspaceId, parentId, movingId, afterId, cancellationToken)
            .ConfigureAwait(false);
        if (slot > 0)
        {
            return slot;
        }

        // Only reachable when the anchor is not among these siblings at all, which the use case
        // checks for and refuses. Appending is the safe answer for a caller that got here anyway:
        // the item lands in the destination, at the end, rather than at position zero alongside
        // whatever else failed to find a slot.
        return await NextSiblingSequenceAsync(workspaceId, parentId, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask InsertAsync(Item item, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(item);

        _dbContext.Items.Add(item);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        // The row has to exist before its edges do: item_closure references it both ways, and the
        // composite foreign keys are checked immediately.
        await _sql.ExecuteAsync(
            ClosureSql.InsertForNewItem,
            [
                Uuid("item_id", item.Id.Value),
                Uuid("tenant_id", item.TenantId.Value),
                Uuid("workspace_id", item.WorkspaceId.Value),
                NullableUuid("parent_id", item.ParentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask UpdatePropertiesAsync(
        ItemId id,
        string properties,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(properties);

        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Properties, properties)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask UpdateSchemaAsync(
        ItemId id,
        string? schema,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Schema, schema)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask UpdateViewsAsync(
        ItemId id,
        string? views,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Views, views)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> WouldCreateCycleAsync(
        ItemId id,
        ItemId parentId,
        CancellationToken cancellationToken) =>
        await _sql.ScalarOrDefaultAsync<bool>(
            ClosureSql.WouldCreateCycle,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("item_id", id.Value),
                Uuid("parent_id", parentId.Value),
            ],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask ReparentAsync(
        ItemId id,
        ItemId? newParentId,
        long seq,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        var item = await _dbContext.Items
            .FirstOrDefaultAsync(candidate => candidate.Id == id, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException(
                $"Item {id} vanished between the caller's check and this write. The use case is "
                + "expected to have found it inside this transaction.");

        // Detach first, then attach. Between the two the subtree is a root, which is a state no
        // reader may observe - both statements run inside the caller's transaction, so none can.
        await _sql.ExecuteAsync(
            ClosureSql.DetachSubtree,
            [Uuid("tenant_id", Tenant.Value), Uuid("item_id", id.Value)],
            cancellationToken).ConfigureAwait(false);

        await _dbContext.Items
            .Where(candidate => candidate.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.ParentId, newParentId)
                    .SetProperty(candidate => candidate.Seq, seq)
                    .SetProperty(candidate => candidate.LastModifiedBy, actor)
                    .SetProperty(candidate => candidate.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

        // Moving to the workspace root leaves the subtree's internal edges and its self-edges,
        // which is the whole of its closure when it has no ancestors.
        if (newParentId is { } parentId)
        {
            await _sql.ExecuteAsync(
                ClosureSql.AttachSubtree,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", item.WorkspaceId.Value),
                    Uuid("item_id", id.Value),
                    Uuid("parent_id", parentId.Value),
                ],
                cancellationToken).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask SetLifecycleAsync(
        ItemId id,
        ItemLifecycleState state,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.LifecycleState, state)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <summary>
    /// Asks the database for a free position, returning zero when there is none.
    /// </summary>
    /// <remarks>
    /// Zero doubles as "no room" because the numbering scheme never produces it: positions start at
    /// a gap and halving a positive minimum stops at one. The alternative - a nullable scalar -
    /// boxes on every call to say something the value range already says.
    /// </remarks>
    private ValueTask<long> SlotAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken) =>
        afterId is { } anchor
            ? _sql.ScalarOrDefaultAsync<long>(
                ClosureSql.SequenceSlotAfter,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", workspaceId.Value),
                    NullableUuid("parent_id", parentId?.Value),
                    Uuid("item_id", movingId.Value),
                    Uuid("after_id", anchor.Value),
                ],
                cancellationToken)
            : _sql.ScalarOrDefaultAsync<long>(
                ClosureSql.SequenceSlotFirst,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", workspaceId.Value),
                    NullableUuid("parent_id", parentId?.Value),
                    Uuid("item_id", movingId.Value),
                ],
                cancellationToken);

    private static NpgsqlParameter UuidArray(string name, Guid[] values) =>
        new(name, NpgsqlDbType.Uuid | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } present ? present : DBNull.Value };

    /// <summary>Reads a single uuid column.</summary>
    private readonly struct ItemIdMapper : INixRowMapper<Guid>
    {
        /// <inheritdoc />
        public Guid Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetGuid(0);
        }
    }
}
