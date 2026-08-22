using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Finds the repeating items a workspace calendar has to expand.
/// </summary>
/// <remarks>
/// <para>
/// A port for the same reason <see cref="IWorkspaceCalendar"/> is one, and it is the same read
/// wearing a second hat: it walks <c>item.views</c> to learn which containers offer a calendar and
/// what each places by - knowledge only Persistence has - and takes the readable workspaces as an
/// argument so the permission filter is a predicate inside the statement rather than a pass over
/// its results.
/// </para>
/// <para>
/// <b>Separate from <see cref="IWorkspaceCalendar"/> deliberately.</b> The two reads answer
/// different questions - what is dated, and what repeats - and are bounded separately, because a
/// workspace can be full of one and empty of the other. Folding them into one statement would
/// spend a single ceiling across both and make a busy calendar hide every series.
/// </para>
/// </remarks>
public interface IRecurrenceCandidates
{
    /// <summary>
    /// The repeating items of one workspace whose series could reach a window.
    /// </summary>
    /// <param name="workspaceId">The workspace being read.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="firstDay">The window's first day, <c>yyyy-MM-dd</c>, inclusive.</param>
    /// <param name="lastDay">The window's last day, <c>yyyy-MM-dd</c>, inclusive.</param>
    /// <param name="candidateLimit">The most candidates to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The candidates, which may be empty.</returns>
    /// <remarks>
    /// Reaching <paramref name="candidateLimit"/> is a truncation the caller must report: there
    /// are more series than were considered, which is a different fact from there being more
    /// entries than were returned.
    /// </remarks>
    public ValueTask<IReadOnlyList<RecurringItem>> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        string firstDay,
        string lastDay,
        int candidateLimit,
        CancellationToken cancellationToken);
}
