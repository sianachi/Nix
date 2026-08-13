using Nix.Domain.Items;

namespace Nix.Domain.Calendar;

/// <summary>
/// A container that offers a calendar but placed nothing, and why.
/// </summary>
/// <param name="ContainerId">The container.</param>
/// <param name="ContainerTitle">What it is called.</param>
/// <remarks>
/// <para>
/// Today there is exactly one reason: the container's calendar view names no property to place by.
/// It is still reported, because the alternative is a calendar that is quietly missing a container
/// somebody deliberately configured - and a reader with no way to tell "nothing is scheduled there"
/// from "that one could not be read" will believe the first.
/// </para>
/// <para>
/// A record rather than a bare identifier so a second reason can be added without changing every
/// call site. When one is, it belongs here as a field rather than as a second list.
/// </para>
/// </remarks>
public sealed record UnplaceableCalendar(ItemId ContainerId, string? ContainerTitle);

/// <summary>
/// Every calendar in one workspace, collated: the dated items the caller may read, and the
/// containers that offered a calendar but could not place anything on it.
/// </summary>
/// <param name="Entries">The dated items, in a stable order.</param>
/// <param name="Unplaceable">The containers that offered a calendar and placed nothing.</param>
/// <remarks>
/// <para>
/// <b>One value rather than two reads.</b> The entries and the containers that failed to produce
/// any are read in one statement, so they describe one instant. Read separately, a container
/// reconfigured between the two could appear in both lists or in neither.
/// </para>
/// <para>
/// Whether the entries were cut short is not recorded here. The ceiling is a property of the use
/// case rather than of the calendar, and a projection carrying its own truncation flag could be
/// built with the flag set wrongly. The handler compares the count against the ceiling it applied -
/// the same division <see cref="Graph.WorkspaceGraph"/> makes, for the same reason.
/// </para>
/// </remarks>
public sealed record WorkspaceCalendar(
    IReadOnlyList<CalendarEntry> Entries,
    IReadOnlyList<UnplaceableCalendar> Unplaceable)
{
    /// <summary>An empty calendar, for a workspace with nothing readable and dated in it.</summary>
    public static WorkspaceCalendar Empty { get; } = new([], []);
}
