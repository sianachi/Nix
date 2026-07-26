using Nix.Application.Authorization;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Tenancy;

namespace Nix.Application.Items;

/// <summary>Reads one page of a folder's children, or the workspace roots.</summary>
/// <remarks>
/// Items the caller cannot read are omitted entirely rather than redacted. A query result is how
/// you enumerate what exists, so a placeholder row would disclose the existence of something the
/// caller was refused - the redaction rule applies to links an author placed, not to listings.
/// </remarks>
public sealed class ListItems
{
    /// <summary>Largest page this use case will return, whatever was asked for.</summary>
    public const int MaximumPageSize = 200;

    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="ListItems"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public ListItems(IItemTree tree, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);

        _tree = tree;
        _permissions = permissions;
    }

    /// <summary>Reads the page.</summary>
    /// <param name="workspaceId">The workspace to read in.</param>
    /// <param name="parentId">The folder, or <see langword="null"/> for the roots.</param>
    /// <param name="includeDeleted">Whether soft-deleted items are included.</param>
    /// <param name="afterSeq">Resume after this sibling position.</param>
    /// <param name="limit">How many to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The children, in sibling order.</returns>
    public async ValueTask<Result<IReadOnlyList<Item>>> ExecuteAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSeq,
        int limit,
        CancellationToken cancellationToken)
    {
        // Existence and permission answer with the same failure, deliberately: a workspace the
        // caller may not read must not be distinguishable from one that does not exist.
        if (!await _tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || !await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<Item>>(
                ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        // A ceiling rather than a rejection: a client asking for ten thousand rows gets a working
        // answer and a cursor, not a 400 telling it to ask again more politely.
        var capped = Math.Clamp(limit, 1, MaximumPageSize);

        var page = await _tree
            .ListChildrenAsync(workspaceId, parentId, includeDeleted, afterSeq, capped, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(page);
    }
}
