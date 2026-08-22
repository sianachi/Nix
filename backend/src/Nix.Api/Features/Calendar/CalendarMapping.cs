using Nix.Domain.Calendar;

namespace Nix.Features.Calendar;

/// <summary>
/// Turns the domain's calendar into the shapes the contract publishes.
/// </summary>
/// <remarks>
/// A projection rather than a serializer attribute on the domain record, so the wire shape can be
/// changed without touching the model and the model can carry things the wire does not - the same
/// division <c>GraphMapping</c> makes.
/// </remarks>
internal static class CalendarMapping
{
    /// <summary>The token a client reads to tell an all-day entry from a moment.</summary>
    /// <remarks>
    /// Lower-case strings rather than the enum's own names, because the contract publishes them and
    /// a rename of a C# member should not be a breaking API change.
    /// </remarks>
    internal const string DateKind = "date";

    /// <summary>The token for an entry that carries a time.</summary>
    internal const string TimestampKind = "timestamp";

    /// <summary>The reason a container-level row names: its calendar view names no date property.</summary>
    /// <remarks>
    /// A token rather than a sentence, so a client can decide how to say it and translate it. The
    /// sentence lives in the client, which is the only place that knows the reader's language.
    /// </remarks>
    internal const string NoDatePropertyReason = "no_date_property";

    /// <summary>
    /// The reason an item-level row names: its container's calendar places by a property other
    /// than the reserved <c>due_date</c> a series always repeats from.
    /// </summary>
    internal const string NotByDueDateReason = "calendar_not_by_due_date";

    /// <summary>
    /// The reason an item-level row names: the item carries no value on the <c>due_date</c> axis
    /// to repeat from.
    /// </summary>
    internal const string NoDueDateReason = "no_due_date";

    /// <summary>
    /// The reason an item-level row names: the stored rule is not one this build could interpret.
    /// </summary>
    internal const string UnreadableRuleReason = "unreadable_rule";

    /// <summary>Projects the merged calendar rows.</summary>
    /// <param name="rows">What the handler merged, concrete entries and generated occurrences alike.</param>
    /// <returns>The entries as the contract publishes them.</returns>
    internal static IReadOnlyList<CalendarEntryResponse> ToEntryResponses(
        IReadOnlyList<CalendarRow> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);

        var responses = new CalendarEntryResponse[rows.Count];
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            var entry = row.Entry;
            responses[index] = new CalendarEntryResponse(
                entry.ItemId.Value,
                entry.Title,
                entry.ContainerId.Value,
                entry.ContainerTitle,
                entry.DateProperty,
                entry.Value,
                entry.Kind == CalendarEntryKind.Date ? DateKind : TimestampKind,
                row.Generated,
                row.Completed);
        }

        return responses;
    }

    /// <summary>Projects the containers and the repeating items that placed nothing.</summary>
    /// <param name="containers">The containers whose calendar view names no property to place by.</param>
    /// <param name="candidates">The repeating items this calendar could not draw, and why.</param>
    /// <returns>The explanations as the contract publishes them, containers first.</returns>
    internal static IReadOnlyList<UnplaceableCalendarResponse> ToUnplaceableResponses(
        IReadOnlyList<UnplaceableCalendar> containers,
        IReadOnlyList<UnplaceableCandidate> candidates)
    {
        ArgumentNullException.ThrowIfNull(containers);
        ArgumentNullException.ThrowIfNull(candidates);

        var responses = new UnplaceableCalendarResponse[containers.Count + candidates.Count];
        var index = 0;

        foreach (var container in containers)
        {
            responses[index] = new UnplaceableCalendarResponse(
                container.ContainerId.Value,
                container.ContainerTitle,
                NoDatePropertyReason,
                ItemId: null,
                ItemTitle: null);
            index++;
        }

        foreach (var candidate in candidates)
        {
            var item = candidate.Candidate;
            responses[index] = new UnplaceableCalendarResponse(
                item.ContainerId.Value,
                item.ContainerTitle,
                candidate.Reason,
                item.ItemId.Value,
                item.ItemTitle);
            index++;
        }

        return responses;
    }
}
