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

    /// <summary>The only reason a calendar can currently place nothing.</summary>
    /// <remarks>
    /// A token rather than a sentence, so a client can decide how to say it and translate it. The
    /// sentence lives in the client, which is the only place that knows the reader's language.
    /// </remarks>
    internal const string NoDatePropertyReason = "no_date_property";

    /// <summary>Projects the dated entries.</summary>
    /// <param name="entries">What the reader found.</param>
    /// <returns>The entries as the contract publishes them.</returns>
    internal static IReadOnlyList<CalendarEntryResponse> ToEntryResponses(
        IReadOnlyList<CalendarEntry> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);

        var responses = new CalendarEntryResponse[entries.Count];
        for (var index = 0; index < entries.Count; index++)
        {
            var entry = entries[index];
            responses[index] = new CalendarEntryResponse(
                entry.ItemId.Value,
                entry.Title,
                entry.ContainerId.Value,
                entry.ContainerTitle,
                entry.DateProperty,
                entry.Value,
                entry.Kind == CalendarEntryKind.Date ? DateKind : TimestampKind);
        }

        return responses;
    }

    /// <summary>Projects the containers that placed nothing.</summary>
    /// <param name="unplaceable">What the reader could not place.</param>
    /// <returns>The explanations as the contract publishes them.</returns>
    internal static IReadOnlyList<UnplaceableCalendarResponse> ToUnplaceableResponses(
        IReadOnlyList<UnplaceableCalendar> unplaceable)
    {
        ArgumentNullException.ThrowIfNull(unplaceable);

        var responses = new UnplaceableCalendarResponse[unplaceable.Count];
        for (var index = 0; index < unplaceable.Count; index++)
        {
            var entry = unplaceable[index];
            responses[index] = new UnplaceableCalendarResponse(
                entry.ContainerId.Value,
                entry.ContainerTitle,
                NoDatePropertyReason);
        }

        return responses;
    }
}
