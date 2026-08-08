using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Finds items the acting principal may read - by what they are called, by what their documents
/// say, or by identifier.
/// </summary>
/// <remarks>
/// <para>
/// A port because the dependency direction requires one: both questions are joins across
/// <c>item</c> and <c>item_search</c>, and only Persistence may write those. It is also the seam a
/// different engine would arrive behind - the moment ranking wants more than Postgres's own text
/// search, nothing above this interface should notice.
/// </para>
/// <para>
/// <b>Every method takes the readable workspaces and none of them works it out.</b> That looks
/// like a caller's chore and is the whole design: the set comes from
/// <see cref="IPermissionResolver"/>, which is the single authorization code path, and passing it
/// in means the filter is a predicate inside the query rather than a pass over its results.
/// Filtering afterwards would let a limit be spent on rows the caller may not see - so a page could
/// come back empty while matches existed - and would compute a ranking against them. An
/// implementation that resolved permissions for itself would be a second authorization path, which
/// is the thing that eventually disagrees with the first.
/// </para>
/// <para>
/// An empty set of readable workspaces is a legitimate answer to ask with, and it returns nothing.
/// A principal who belongs to no workspace searches an empty product rather than an error.
/// </para>
/// </remarks>
public interface IItemSearch
{
    /// <summary>
    /// Items whose title or document text matches, most relevant first.
    /// </summary>
    /// <param name="query">What the person typed. Never a pattern; never SQL.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="limit">The most results to return.</param>
    /// <param name="cancellationToken">Cancels the search.</param>
    /// <returns>The matches, ordered with title matches first.</returns>
    /// <remarks>
    /// A title match ranks above a body match: somebody typing into a palette is usually trying to
    /// reach a document they can already name, and the note merely mentioning the word must not
    /// come above the note called it.
    /// </remarks>
    public ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>
    /// The items among <paramref name="itemIds"/> that the caller may read.
    /// </summary>
    /// <param name="itemIds">The identifiers to resolve.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// A digest per readable identifier, in no particular order, and nothing at all for the rest.
    /// </returns>
    /// <remarks>
    /// <b>What a document's references resolve against, and the reason a title cannot leak.</b> A
    /// reference node carries the target's title as it was when the link was made, cached for
    /// rendering - and that cache is a title the reader may have no entitlement to. An identifier
    /// missing from the result is one of three things: it never existed, it was deleted, or it is
    /// in a workspace this caller cannot reach. They are deliberately indistinguishable, because
    /// telling them apart is how an outsider enumerates a tenant one identifier at a time.
    /// </remarks>
    public ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
        IReadOnlyList<ItemId> itemIds,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken);
}
