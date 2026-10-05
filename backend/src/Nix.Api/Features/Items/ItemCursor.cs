using System.Globalization;
using Nix.Domain.Items;

namespace Nix.Features.Items;

/// <summary>
/// The opaque cursor for paging a folder's children.
/// </summary>
/// <remarks>
/// <para>
/// It encodes the last sibling position returned, which is what makes the next page resume from a
/// position rather than an offset: a row inserted while a client walks the list shifts every later
/// offset, so offset pages silently skip and repeat items.
/// </para>
/// <para>
/// Opaque by contract, and only just: today it is the number as text. Clients pass back exactly
/// what they were given and never construct or parse one, which is what lets this become something
/// signed or compound later without breaking anybody.
/// </para>
/// </remarks>
internal static class ItemCursor
{
    /// <summary>Reads a cursor back into a sibling position.</summary>
    /// <param name="cursor">The cursor a client returned, or <see langword="null"/>.</param>
    /// <returns>The position to resume after, or <see langword="null"/> to start.</returns>
    /// <remarks>
    /// An unparseable cursor starts from the beginning rather than failing. It can only have come
    /// from a mangled URL, and a first page is a more useful answer than an error about a value the
    /// client was told to treat as meaningless.
    /// </remarks>
    internal static long? Decode(string? cursor) =>
        long.TryParse(cursor, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seq)
            ? seq
            : null;

    /// <summary>Builds the cursor for the page after this one.</summary>
    /// <param name="page">The page just read.</param>
    /// <param name="limit">The page size that was asked for.</param>
    /// <returns>The next cursor, or <see langword="null"/> on the last page.</returns>
    /// <remarks>
    /// Null - present and null, never absent - when the page came back short, because a short page
    /// is the only honest signal that there is no more. Exhaustion is then something the client's
    /// schema can prove rather than infer from a missing key.
    /// </remarks>
    internal static string? NextFrom(IReadOnlyList<Item> page, int limit) =>
        page.Count > 0 && page.Count >= limit
            ? page[^1].Seq.ToString(CultureInfo.InvariantCulture)
            : null;
}
