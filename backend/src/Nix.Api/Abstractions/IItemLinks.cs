using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Reads the link graph documents produce.
/// </summary>
/// <remarks>
/// <para>
/// Read-only, and permanently so. The edges are extracted by the collaboration service when it
/// materialises a document, because that is the only place a merged document exists; Core holds
/// <c>SELECT</c> on the table and nothing else. A write method here would be a method no
/// implementation could carry out.
/// </para>
/// <para>
/// A port for the same two reasons <see cref="IItemSearch"/> is one: the query joins tables only
/// Persistence may write, and the readable workspaces are passed in rather than resolved here, so
/// the permission filter is a predicate inside the query instead of a pass over its results.
/// </para>
/// </remarks>
public interface IItemLinks
{
    /// <summary>
    /// The documents that refer to an item, most-referring first.
    /// </summary>
    /// <param name="targetId">The item being pointed at.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="limit">The most backlinks to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The referring documents, which may be empty.</returns>
    /// <remarks>
    /// <b>The workspace filter applies to the source, not the target.</b> The source is what is
    /// being disclosed: a reader entitled to the item in front of them is not thereby entitled to
    /// learn that a document in a workspace they cannot reach mentions it. That is why the count a
    /// panel shows has to come from this list rather than from the table.
    /// </remarks>
    public ValueTask<IReadOnlyList<Backlink>> BacklinksAsync(
        ItemId targetId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>
    /// The items most often linked from the same documents that link to an item, most shared
    /// sources first.
    /// </summary>
    /// <param name="targetId">The item whose co-citations are wanted. Never returned itself.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="sourceLimit">
    /// The most referring documents considered, taken most-referring first. This is the bound on
    /// the work: a hub linked from thousands of documents is read as its top sources, not all of
    /// them.
    /// </param>
    /// <param name="limit">The most related items to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The related items, which may be empty.</returns>
    /// <remarks>
    /// <b>The workspace filter applies twice</b>: to each source, because a source's links are a
    /// statement about that document and only a readable, unlocked one may contribute to a count;
    /// and to each result, because a result is disclosed. Being entitled to the target says
    /// nothing about either. A result under a lock this credential has not opened is left out as
    /// well, because a lock hides the titles under it (ADR-0056).
    /// </remarks>
    public ValueTask<IReadOnlyList<RelatedItem>> RelatedAsync(
        ItemId targetId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int sourceLimit,
        int limit,
        CancellationToken cancellationToken);
}
