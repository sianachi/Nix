using Nix.Core.Items;
using Nix.Core.Tenancy;

namespace Nix.Application.Items;

/// <summary>
/// Storage for the item tree: the envelope rows and the closure edges that make ancestry a range
/// scan.
/// </summary>
/// <remarks>
/// <para>
/// A port because the dependency direction requires one - use cases live in this assembly and the
/// implementation needs EF Core and Npgsql, which only Infrastructure may reference. That is the
/// justification the interface guardrail asks for; there is no second implementation and none is
/// planned.
/// </para>
/// <para>
/// <b>Every method is tenant-scoped implicitly, never by parameter.</b> The tenant comes from the
/// session context the request pipeline established, and is published to Postgres as a
/// transaction-local setting that the row-level security policies read. A tenant argument here
/// would be a second source of truth for the same fact, and the failure mode of the two
/// disagreeing is a cross-tenant read.
/// </para>
/// <para>
/// The closure table is maintained by the implementations of <see cref="InsertAsync"/> and
/// <see cref="ReparentAsync"/> and by nothing else. It is derived data: correct because those two
/// are, and rebuildable from <c>parent_id</c> if they ever are not.
/// </para>
/// </remarks>
public interface IItemTree
{
    /// <summary>Finds one item.</summary>
    /// <param name="id">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The item, or <see langword="null"/> when it does not exist or is not visible.</returns>
    public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken);

    /// <summary>Which of these items have at least one child that is not deleted.</summary>
    /// <param name="workspaceId">The workspace the items live in.</param>
    /// <param name="parents">The items to ask about.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The subset that have children. Items with none are simply absent.</returns>
    /// <remarks>
    /// <para>
    /// <b>Asked about a page at a time, not about a row at a time.</b> The interface needs this to
    /// decide whether an item gets an expand control, and an item that offers one and then expands
    /// to nothing is the dishonest state the whole tree would otherwise be full of - every item can
    /// hold children, so without this every item would have to claim it might.
    /// </para>
    /// <para>
    /// Derived, and deliberately not a column on <c>Item</c>: it is a fact about other rows, it
    /// changes when they do, and storing it would be a counter to keep correct through every move,
    /// delete and restore.
    /// </para>
    /// </remarks>
    public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        CancellationToken cancellationToken);

    /// <summary>Reads one page of a parent's children, in sibling order.</summary>
    /// <param name="workspaceId">The workspace to read in.</param>
    /// <param name="parentId">The parent, or <see langword="null"/> for the workspace roots.</param>
    /// <param name="includeDeleted">Whether soft-deleted items are included.</param>
    /// <param name="afterSeq">Resume after this sibling position, or <see langword="null"/> to start.</param>
    /// <param name="limit">How many to return at most.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The children, ordered by sibling position.</returns>
    public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSeq,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>Whether a workspace exists and is visible to this session.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when it can be seen.</returns>
    public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Allocates the next sibling position under a parent.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="parentId">The parent, or <see langword="null"/> for the roots.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>A position after every current sibling.</returns>
    public ValueTask<long> NextSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken);

    /// <summary>
    /// Allocates the position an item should take among a parent's children when it is placed
    /// immediately after a named sibling, or first when none is named.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="parentId">The destination parent, or <see langword="null"/> for the roots.</param>
    /// <param name="movingId">The item being placed, excluded from its own neighbour search.</param>
    /// <param name="afterId">
    /// The sibling to sit immediately after, or <see langword="null"/> to sit before all of them.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>A position that orders the item where the caller asked.</returns>
    /// <remarks>
    /// Positions are sparse, so the ordinary answer is a number between two neighbours and costs
    /// one statement. When two neighbours are adjacent there is no such number, and the
    /// implementation renumbers that parent's children and asks again rather than placing the item
    /// somewhere the caller did not ask for. Both outcomes are the same to the caller, which is why
    /// this is one port method and not a protocol.
    /// </remarks>
    public ValueTask<long> AllocateSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken);

    /// <summary>Stores a new item and its closure edges.</summary>
    /// <param name="item">The item to store.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when both are written.</returns>
    public ValueTask InsertAsync(Item item, CancellationToken cancellationToken);

    /// <summary>Replaces an item's property bag.</summary>
    /// <param name="id">The item.</param>
    /// <param name="properties">The new bag.</param>
    /// <param name="actor">Who made the change.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is updated.</returns>
    public ValueTask UpdatePropertiesAsync(
        ItemId id,
        string properties,
        Core.Identity.PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken);

    /// <summary>Replaces the schema an item declares for its subtree.</summary>
    /// <param name="id">The item.</param>
    /// <param name="schema">The schema as JSON, or <see langword="null"/> to declare none.</param>
    /// <param name="actor">Who made the change.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is updated.</returns>
    /// <remarks>
    /// Separate from <see cref="UpdatePropertiesAsync"/> because they are different things that
    /// happen at different times: a schema is authored occasionally by somebody shaping a
    /// workspace, and property values are written constantly by everybody using it.
    /// </remarks>
    public ValueTask UpdateSchemaAsync(
        ItemId id,
        string? schema,
        Core.Identity.PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken);

    /// <summary>Replaces the views a container offers.</summary>
    /// <param name="id">The container.</param>
    /// <param name="views">The views as JSON, or <see langword="null"/> to offer none.</param>
    /// <param name="actor">Who made the change.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is updated.</returns>
    public ValueTask UpdateViewsAsync(
        ItemId id,
        string? views,
        Core.Identity.PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken);

    /// <summary>
    /// Whether making <paramref name="parentId"/> the parent of <paramref name="id"/> would put
    /// the item inside its own subtree.
    /// </summary>
    /// <param name="id">The item that would move.</param>
    /// <param name="parentId">The proposed parent.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when the move would create a cycle.</returns>
    public ValueTask<bool> WouldCreateCycleAsync(
        ItemId id,
        ItemId parentId,
        CancellationToken cancellationToken);

    /// <summary>Moves an item and rewrites the closure edges of its whole subtree.</summary>
    /// <param name="id">The item to move.</param>
    /// <param name="newParentId">The new parent, or <see langword="null"/> for the workspace root.</param>
    /// <param name="seq">The item's position among its new siblings.</param>
    /// <param name="actor">Who made the change.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the tree and its closure agree again.</returns>
    public ValueTask ReparentAsync(
        ItemId id,
        ItemId? newParentId,
        long seq,
        Core.Identity.PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken);

    /// <summary>Changes an item's lifecycle state.</summary>
    /// <param name="id">The item.</param>
    /// <param name="state">The new state.</param>
    /// <param name="actor">Who made the change.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is updated.</returns>
    /// <remarks>
    /// Soft deletion is a flag flip on one row and never a cascade: the subtree stays intact and
    /// its descendants become invisible by closure derivation, which is what makes restoring the
    /// same flip back rather than a reconstruction.
    /// </remarks>
    public ValueTask SetLifecycleAsync(
        ItemId id,
        ItemLifecycleState state,
        Core.Identity.PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken);
}
