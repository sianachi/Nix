using System.Globalization;

namespace Nix.Features.Notifications;

/// <summary>
/// The opaque cursor for paging a principal's inbox: the <c>seq</c> of the last item returned.
/// An unparseable cursor starts from the beginning, the same reasoning as <c>ItemCursor</c> - a
/// mangled query string is more useful answered with a first page than with an error about a
/// value the client was told to treat as meaningless.
/// </summary>
internal static class NotificationCursor
{
    /// <summary>Reads a cursor back into the sequence to resume after, or <see langword="null"/> to start.</summary>
    internal static long? Decode(string? cursor) =>
        long.TryParse(cursor, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seq) ? seq : null;
}
