using Nix.Domain.Items;

namespace Nix.Domain.Calendar;

/// <summary>
/// One item on a workspace's calendar: what it is called, when it is, and which container decided
/// that.
/// </summary>
/// <param name="ItemId">The item that is dated.</param>
/// <param name="Title">What it is called, or <see langword="null"/> when it has never been named.</param>
/// <param name="ContainerId">The container whose calendar view placed it.</param>
/// <param name="ContainerTitle">
/// What that container is called. Carried rather than left for the client to resolve, because the
/// point of a collated calendar is that an item from anywhere can say where it came from, and a
/// client holding only an identifier would have to fetch the workspace tree to render one line.
/// </param>
/// <param name="DateProperty">
/// The property key the container's calendar view names. Two containers may place their children
/// on differently named properties and both are correct; a collated calendar has to carry the key
/// per entry rather than assume one for the workspace.
/// </param>
/// <param name="Value">
/// The stored value, verbatim. Either a <c>yyyy-MM-dd</c> date or an RFC 9557 timestamp with a
/// bracketed zone.
/// </param>
/// <remarks>
/// <para>
/// <b>The value is not parsed here, and that is deliberate.</b> A <c>date</c> is a day and a
/// <c>timestamp</c> is a moment in a named zone, and only the reader's own zone decides which day a
/// moment falls on. Parsing server-side would mean choosing a zone on the reader's behalf and
/// baking it into the payload - so the server windows coarsely by the leading ten characters and
/// the client places precisely. <see cref="Kind"/> tells the client which of the two it is holding
/// without it having to sniff the string.
/// </para>
/// <para>
/// <b>An entry exists only for an item the caller may read.</b> Nothing constructs one to stand in
/// for an item they may not: a placeholder on a calendar would disclose that something is scheduled
/// and hide only what, which is most of what a date is.
/// </para>
/// </remarks>
public sealed record CalendarEntry(
    ItemId ItemId,
    string? Title,
    ItemId ContainerId,
    string? ContainerTitle,
    string DateProperty,
    string Value)
{
    /// <summary>Whether this entry is an all-day date or a moment.</summary>
    /// <remarks>
    /// Derived from the stored shape rather than from the schema, so it is a fact about the value
    /// in hand. A <c>yyyy-MM-dd</c> date is exactly ten characters; anything longer carries a time.
    /// Reading the schema instead would be a second source of truth that a value written before a
    /// property was retyped could disagree with.
    /// </remarks>
    public CalendarEntryKind Kind =>
        Value.Length == 10 ? CalendarEntryKind.Date : CalendarEntryKind.Timestamp;
}

/// <summary>Which of the two dated shapes an entry carries.</summary>
public enum CalendarEntryKind
{
    /// <summary>An all-day date, <c>yyyy-MM-dd</c>.</summary>
    Date = 0,

    /// <summary>A moment in a named zone, RFC 9557.</summary>
    Timestamp = 1,
}
