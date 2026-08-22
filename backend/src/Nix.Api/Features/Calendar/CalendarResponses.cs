namespace Nix.Features.Calendar;

/// <summary>One dated item, and where its date came from.</summary>
/// <param name="ItemId">The item that is dated.</param>
/// <param name="Title">
/// What it is called, or <see langword="null"/> when it has never been named. The client decides
/// what to draw for an unnamed item; the server does not invent a name for it.
/// </param>
/// <param name="ContainerId">The container whose calendar view placed it.</param>
/// <param name="ContainerTitle">
/// What that container is called. Carried so an entry can say where it came from without the client
/// fetching the tree to render one line.
/// </param>
/// <param name="DateProperty">
/// The property key the container places by. Different containers may use different keys and all of
/// them are correct, which is the whole reason a collated calendar carries the key per entry.
/// </param>
/// <param name="Value">
/// The stored value, verbatim: either a plain <c>yyyy-MM-dd</c> day or an RFC 9557 moment with a
/// bracketed zone. Not normalised, because only the reader's own zone decides which day a moment
/// falls on.
/// </param>
/// <param name="Kind">
/// Which of the two dated property types placed this entry, named exactly as
/// <see cref="Domain.Properties.PropertyType"/> spells it, so a client can tell an all-day entry
/// from a moment without parsing the value to find out.
/// </param>
/// <param name="Generated">
/// Whether a recurrence rule produced this row rather than it being read from storage. A client
/// draws these the same as any other entry but must not offer to edit or delete the row itself -
/// there is no row, only the series that produced it.
/// </param>
/// <param name="Completed">
/// The occurrence's completion state when <see cref="Generated"/> is <see langword="true"/>;
/// <see langword="null"/> for a concrete entry, which has no completion state of its own to carry.
/// </param>
internal sealed record CalendarEntryResponse(
    Guid ItemId,
    string? Title,
    Guid ContainerId,
    string? ContainerTitle,
    string DateProperty,
    string Value,
    string Kind,
    bool Generated,
    bool? Completed);

/// <summary>
/// A container that offered a calendar and placed nothing on it, or an item that repeats and could
/// not be drawn on one.
/// </summary>
/// <param name="ContainerId">The container - the one that offered the calendar either way.</param>
/// <param name="ContainerTitle">What it is called.</param>
/// <param name="Reason">
/// Why nothing could be placed, in a stable machine-readable token. <c>no_date_property</c> is a
/// container-level reason: the calendar view names no property to place by, and
/// <see cref="ItemId"/> is <see langword="null"/> for it. The other three name an item that
/// repeats but could not ride this calendar's axis: <c>calendar_not_by_due_date</c> (the
/// container's calendar places by a property other than the reserved <c>due_date</c> a series
/// always repeats from), <c>no_due_date</c> (the item carries no value on that axis to repeat
/// from), and <c>unreadable_rule</c> (the stored rule is not one this build could interpret).
/// </param>
/// <param name="ItemId">
/// The repeating item, for the three item-level reasons; <see langword="null"/> for
/// <c>no_date_property</c>, which names only the container.
/// </param>
/// <param name="ItemTitle">What the item is called, when <see cref="ItemId"/> is not null.</param>
internal sealed record UnplaceableCalendarResponse(
    Guid ContainerId,
    string? ContainerTitle,
    string Reason,
    Guid? ItemId,
    string? ItemTitle);

/// <summary>Every calendar in one workspace, collated into one set of dated entries.</summary>
/// <param name="WorkspaceId">The workspace that was read.</param>
/// <param name="From">The first day of the window, inclusive.</param>
/// <param name="To">The last day of the window, inclusive.</param>
/// <param name="Entries">
/// The dated items, earliest first - concrete entries and the occurrences a recurrence rule
/// generated, merged into one order.
/// </param>
/// <param name="Unplaceable">
/// The containers that offer a calendar and placed nothing, and the repeating items this calendar
/// could not draw. Never truncated: it is the part of the answer that explains what is missing, and
/// cutting it could remove the explanation for the cut.
/// </param>
/// <param name="EntryLimit">The ceiling that was applied to <paramref name="Entries"/>.</param>
/// <param name="EntriesTruncated">
/// Whether that ceiling was reached, so the window holds more than this response carries. A
/// truncated list looks short and says so; a truncated calendar looks like a calendar, so a client
/// must say it out loud.
/// </param>
/// <param name="SeriesTruncated">
/// Whether more repeating series exist than this read considered, or than the merge had room to
/// expand. Deliberately a second flag rather than folded into <paramref name="EntriesTruncated"/>:
/// "there are more entries than were returned" and "there are more series than were considered" are
/// different facts about the same read, and a client acts on them differently - the first says a
/// narrower window would show more, the second says a series exists that this response may not
/// even mention.
/// </param>
internal sealed record WorkspaceCalendarResponse(
    Guid WorkspaceId,
    string From,
    string To,
    IReadOnlyList<CalendarEntryResponse> Entries,
    IReadOnlyList<UnplaceableCalendarResponse> Unplaceable,
    int EntryLimit,
    bool EntriesTruncated,
    bool SeriesTruncated);
