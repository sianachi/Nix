using Nix.Domain.Graph;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Reads a workspace as a graph: the items the acting principal may see, and the reference edges
/// between them.
/// </summary>
/// <remarks>
/// <para>
/// A port for the same reasons <see cref="IItemSearch"/> and <see cref="IItemLinks"/> are ports:
/// the read joins <c>item</c> to <c>item_link</c>, which only Persistence may write, and the
/// readable workspaces are handed in rather than resolved here so the permission filter is a
/// predicate inside the statement.
/// </para>
/// <para>
/// <b>This is a bulk titles-and-structure surface, which is what makes the predicate's position
/// load-bearing rather than tidy.</b> Every other read in the product starts from an identifier the
/// caller already holds; this one returns the name and the parent of everything at once. A filter
/// applied to the rows after they are read would still be a query that read them, and the ceiling
/// would already have been spent on items the caller may not see - so a workspace they share a
/// corner of could come back empty while the rest of it filled the limit. There is no shape of that
/// bug that is merely a defect.
/// </para>
/// <para>
/// An empty set of readable workspaces is a legitimate answer to ask with, and it returns an empty
/// graph rather than an error.
/// </para>
/// </remarks>
public interface IWorkspaceGraph
{
    /// <summary>
    /// The readable items of one workspace and the reference edges between them.
    /// </summary>
    /// <param name="workspaceId">The workspace being drawn.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="nodeLimit">The most nodes to return.</param>
    /// <param name="linkLimit">The most links to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The graph, which may be empty.</returns>
    /// <remarks>
    /// <para>
    /// <paramref name="workspaceId"/> says which workspace was asked for;
    /// <paramref name="readableWorkspaces"/> says which ones may be answered. Both are predicates
    /// in the statement, and the implementation does not intersect them for itself: today they
    /// happen to be equivalent to a single membership test, and the moment access control entries
    /// make visibility per item the second predicate is the one that grows.
    /// </para>
    /// <para>
    /// A link is returned only when both of its ends are among the nodes returned, so nothing in
    /// the result points outside it - including at an item that exists, in this workspace, and is
    /// missing only because the node ceiling was reached.
    /// </para>
    /// </remarks>
    public ValueTask<WorkspaceGraph> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int nodeLimit,
        int linkLimit,
        CancellationToken cancellationToken);
}
