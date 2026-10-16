using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>An item My Day may turn into a task or a habit row, exactly as stored.</summary>
/// <param name="Id">The original item.</param>
/// <param name="WorkspaceId">Its workspace.</param>
/// <param name="ContainerId">Its parent, or null at the workspace root.</param>
/// <param name="ContainerTitle">The parent's title when the parent is visible.</param>
/// <param name="Title">The item's title.</param>
/// <param name="PropertiesJson">The property bag as stored.</param>
/// <param name="RecurrenceJson">The recurrence rule as stored, or null when the item does not repeat.</param>
public sealed record MyDayCandidate(
    ItemId Id,
    WorkspaceId WorkspaceId,
    ItemId? ContainerId,
    string? ContainerTitle,
    string? Title,
    string? PropertiesJson,
    string? RecurrenceJson);

/// <summary>One kind of candidate, and whether the read stopped at its ceiling.</summary>
/// <param name="Rows">At most the requested number of candidates.</param>
/// <param name="Truncated">Whether more candidates matched than <paramref name="Rows"/> holds.</param>
public sealed record MyDayBatch(IReadOnlyList<MyDayCandidate> Rows, bool Truncated);

/// <summary>What one My Day read found before any schema or habit rule judged it.</summary>
/// <param name="Tasks">Items that might be tasks.</param>
/// <param name="Habits">Items carrying habit settings.</param>
public sealed record MyDayCandidates(MyDayBatch Tasks, MyDayBatch Habits);

/// <summary>
/// Finds the items one workspace's My Day might show.
/// </summary>
/// <remarks>
/// <para>
/// A port because the read is persistence knowledge end to end - property-bag predicates, the
/// closure's visibility rules and the credential's unlocked locks - and because the handler's tests
/// need a fake that answers without a database.
/// </para>
/// <para>
/// <b>A superset, never a verdict.</b> The statement may return an item the effective schema later
/// rejects (a bag key spelled like a task field). It must never withhold one that qualifies, and
/// every visibility rule applies before the ceiling is spent, so a ceiling is never consumed by
/// rows the caller may not see.
/// </para>
/// </remarks>
public interface IMyDayCandidates
{
    /// <summary>Reads the candidates for one workspace the caller has already been allowed to read.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="principalId">The acting principal, whose assignments count as theirs.</param>
    /// <param name="today">The task day.</param>
    /// <param name="taskLimit">The most task candidates to return.</param>
    /// <param name="habitLimit">The most habit candidates to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The candidates.</returns>
    /// <exception cref="ItemQueryFailedException">The statement timed out or failed on stored data.</exception>
    public ValueTask<MyDayCandidates> ReadAsync(
        WorkspaceId workspaceId,
        PrincipalId principalId,
        DateOnly today,
        int taskLimit,
        int habitLimit,
        CancellationToken cancellationToken);
}
