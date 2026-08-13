using Nix.Domain.Calendar;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Reads every calendar in one workspace as a single set of dated entries.
/// </summary>
/// <remarks>
/// <para>
/// A port for the same reasons <see cref="IWorkspaceGraph"/> is one: the read walks
/// <c>item.views</c> to discover which containers offer a calendar and what each places by, then
/// joins their children - all of which only Persistence may know about - and the readable
/// workspaces are handed in rather than resolved here so the permission filter is a predicate
/// inside the statement.
/// </para>
/// <para>
/// <b>This is a bulk disclosure surface, which is what makes the predicate's position load-bearing
/// rather than tidy.</b> It returns the title and the date of everything scheduled at once. A
/// filter applied to the rows after they were read would still be a query that read them, and the
/// ceiling would already have been spent on items the caller may not see - so a workspace they
/// share a corner of could come back looking empty for a month that is full. The same reasoning
/// <see cref="IWorkspaceGraph"/> writes down, and it is not weaker here for being about dates.
/// </para>
/// <para>
/// An empty set of readable workspaces is a legitimate thing to ask with, and answers an empty
/// calendar rather than an error.
/// </para>
/// </remarks>
public interface IWorkspaceCalendar
{
    /// <summary>
    /// The dated items of one workspace, within a window.
    /// </summary>
    /// <param name="workspaceId">The workspace being read.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="firstDay">The first day to include, as <c>yyyy-MM-dd</c>. Inclusive.</param>
    /// <param name="lastDay">The last day to include, as <c>yyyy-MM-dd</c>. Inclusive.</param>
    /// <param name="entryLimit">The most entries to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The calendar, which may be empty.</returns>
    /// <remarks>
    /// <para>
    /// <paramref name="workspaceId"/> says which workspace was asked for;
    /// <paramref name="readableWorkspaces"/> says which ones may be answered. Both are predicates
    /// in the statement, and the implementation does not intersect them for itself - the moment
    /// access control entries make visibility per item, the second predicate is the one that grows.
    /// </para>
    /// <para>
    /// <b>The window is coarse on purpose.</b> It is compared against the first ten characters of
    /// the stored value, which is the day for both shapes a date can be stored in. A moment near
    /// midnight in a distant zone can therefore fall inside the window here and outside it for the
    /// reader, or the reverse. That is the correct division of labour: only the reader's own zone
    /// decides which day a moment belongs to, so the server fetches generously and the client
    /// places exactly.
    /// </para>
    /// </remarks>
    public ValueTask<WorkspaceCalendar> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        string firstDay,
        string lastDay,
        int entryLimit,
        CancellationToken cancellationToken);
}
