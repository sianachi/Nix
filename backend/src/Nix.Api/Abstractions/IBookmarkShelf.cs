using Nix.Domain.Bookmarks;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// One principal's kept items: what is on the shelf, and putting things on and off it.
/// </summary>
/// <remarks>
/// <para>
/// A port for the reason <see cref="IWorkspaceGraph"/> is one: the list read joins <c>bookmark</c>
/// to <c>item</c> to answer with titles, and the readable workspaces are handed in rather than
/// resolved here so the permission filter is a predicate inside the statement.
/// </para>
/// <para>
/// <b>The acting principal is never a parameter.</b> Every method takes the principal from the
/// session context the unit of work was opened with, the same way <c>GET /api/v1/me</c> does. A
/// principal identifier that arrived from a client would be an authorization decision made by
/// whoever typed the request.
/// </para>
/// </remarks>
public interface IBookmarkShelf
{
    /// <summary>
    /// What the acting principal has kept, most recently kept first.
    /// </summary>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The kept items, which may be empty.</returns>
    /// <remarks>
    /// <para>
    /// <b>A bookmark survives losing access to what it points at, and the read must not.</b> Being
    /// removed from a workspace does not delete the rows - there is nothing to delete them from,
    /// short of a job that watches memberships - so the list filters by what the caller may read
    /// today, inside the statement. Filtering afterwards would mean the titles had already been
    /// read, and a title is the disclosure.
    /// </para>
    /// <para>
    /// The row is left in place rather than tidied away, because access can come back and a shelf
    /// that quietly emptied itself during a week off would be worse than one that hides a few
    /// entries while they are unreachable.
    /// </para>
    /// </remarks>
    public ValueTask<IReadOnlyList<KeptItem>> ListAsync(
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken);

    /// <summary>
    /// How many items are on the shelf at all, including ones the list cannot show.
    /// </summary>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The row count.</returns>
    /// <remarks>
    /// Subtracting the list's length from this is what lets a response say the shelf is larger than
    /// what came back, without naming what is missing. See <see cref="ListAsync"/> for why rows
    /// outlive access to what they point at.
    /// </remarks>
    public ValueTask<int> CountAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Puts an item on the acting principal's shelf.
    /// </summary>
    /// <param name="itemId">The item to keep.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when a row was written, <see langword="false"/> otherwise.</returns>
    /// <remarks>
    /// <para>
    /// Idempotent by primary key rather than by a read-then-write: two tabs keeping the same item at
    /// once is an ordinary race, and the honest resolution is one row and no error.
    /// </para>
    /// <para>
    /// <b>The readable workspaces are a parameter here too, and they are what makes this safe.</b>
    /// The insert selects the item rather than trusting the identifier, so keeping something is
    /// possible only for something the caller can see. Without it anybody could put any identifier
    /// on their own shelf and read its title back from the list - which turns a shelf into an
    /// oracle for whether an item exists.
    /// </para>
    /// <para>
    /// <see langword="false"/> therefore means one of two things - already kept, or not visible -
    /// and the handler deliberately does not distinguish them to the caller, for the same reason a
    /// workspace nobody may see is reported as not found.
    /// </para>
    /// </remarks>
    public ValueTask<bool> KeepAsync(
        ItemId itemId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken);

    /// <summary>
    /// Takes an item off the acting principal's shelf.
    /// </summary>
    /// <param name="itemId">The item to release.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when it was there, <see langword="false"/> when it was not.</returns>
    /// <remarks>
    /// Removing something that is not on the shelf is not an error. The reader asked for it to be
    /// off, and it is off - reporting a failure would make an unbookmark button fail because
    /// somebody pressed it twice.
    /// </remarks>
    public ValueTask<bool> ReleaseAsync(ItemId itemId, CancellationToken cancellationToken);
}
