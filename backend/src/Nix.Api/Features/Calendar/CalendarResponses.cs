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
internal sealed record CalendarEntryResponse(
    Guid ItemId,
    string? Title,
    Guid ContainerId,
    string? ContainerTitle,
    string DateProperty,
    string Value,
    string Kind);

/// <summary>A container that offers a calendar and could place nothing on it.</summary>
/// <param name="ContainerId">The container.</param>
/// <param name="ContainerTitle">What it is called.</param>
/// <param name="Reason">
/// Why nothing could be placed, in a stable machine-readable token. Today the only value is
/// <c>no_date_property</c>: the calendar view names no property to place by.
/// </param>
internal sealed record UnplaceableCalendarResponse(
    Guid ContainerId,
    string? ContainerTitle,
    string Reason);

/// <summary>Every calendar in one workspace, collated into one set of dated entries.</summary>
/// <param name="WorkspaceId">The workspace that was read.</param>
/// <param name="From">The first day of the window, inclusive.</param>
/// <param name="To">The last day of the window, inclusive.</param>
/// <param name="Entries">The dated items, earliest first.</param>
/// <param name="Unplaceable">
/// The containers that offer a calendar and placed nothing. Never truncated: it is the part of the
/// answer that explains what is missing, and cutting it could remove the explanation for the cut.
/// </param>
/// <param name="EntryLimit">The ceiling that was applied to <paramref name="Entries"/>.</param>
/// <param name="EntriesTruncated">
/// Whether that ceiling was reached, so the window holds more than this response carries. A
/// truncated list looks short and says so; a truncated calendar looks like a calendar, so a client
/// must say it out loud.
/// </param>
internal sealed record WorkspaceCalendarResponse(
    Guid WorkspaceId,
    string From,
    string To,
    IReadOnlyList<CalendarEntryResponse> Entries,
    IReadOnlyList<UnplaceableCalendarResponse> Unplaceable,
    int EntryLimit,
    bool EntriesTruncated);
