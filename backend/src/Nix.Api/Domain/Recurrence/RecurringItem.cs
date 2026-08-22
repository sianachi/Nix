using Nix.Domain.Items;

namespace Nix.Domain.Recurrence;

/// <summary>
/// A repeating item as the calendar meets it: the rule, the day it repeats from, and enough of the
/// item to draw an occurrence.
/// </summary>
/// <remarks>
/// <b>A candidate, not an occurrence.</b> Which days this lands on is a function of the rule, the
/// anchor and the window being drawn, computed by <see cref="RecurrenceExpansion"/> at read time.
/// </remarks>
/// <param name="ItemId">The repeating item.</param>
/// <param name="ItemTitle">Its title, or null when it has none.</param>
/// <param name="ContainerId">The container whose calendar draws it.</param>
/// <param name="ContainerTitle">That container's title, or null.</param>
/// <param name="DateProperty">The property the container's calendar places by.</param>
/// <param name="Anchor">
/// The day the series repeats from, or null when the item carries no value on that property - a
/// series with nothing to repeat from, which is reported rather than dropped.
/// </param>
/// <param name="Rule">The rule, or null when this build could not interpret what was stored.</param>
public sealed record RecurringItem(
    ItemId ItemId,
    string? ItemTitle,
    ItemId ContainerId,
    string? ContainerTitle,
    string DateProperty,
    DateOnly? Anchor,
    RecurrenceRule? Rule)
{
    /// <summary>Whether this candidate can produce occurrences at all.</summary>
    /// <remarks>
    /// Both halves are needed and each fails for its own reason: no anchor means the item has no
    /// date on the axis its calendar draws, and no rule means the stored JSON is one this build
    /// declined to interpret (<see cref="RecurrenceRuleJson"/> fails closed). The calendar reports
    /// each as unplaceable rather than silently drawing nothing.
    /// </remarks>
    public bool CanExpand => Anchor is not null && Rule is not null;
}
