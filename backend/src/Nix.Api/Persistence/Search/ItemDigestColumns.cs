using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Npgsql;

namespace Nix.Persistence.Search;

/// <summary>
/// Reads the six columns every item-listing statement in <c>SearchSql</c> projects first, in the
/// same order: <c>id</c>, <c>workspace_id</c>, <c>type</c>, <c>title</c>, <c>parent_id</c>,
/// <c>last_modified_at</c>.
/// </summary>
/// <remarks>
/// <para>
/// One reader rather than one per mapper, because search, resolution, backlinks, related items and
/// mentions all publish the same hit shape. Four hand-written copies of "column three is the title"
/// is how one of them ends up reading the parent into the title the day a column is added - which
/// is exactly the change that introduced this type.
/// </para>
/// <para>
/// The title is nullable in the database and stays nullable here: an item that has never been named
/// is a real state, and inventing "Untitled" in the persistence layer would put a piece of
/// user-facing copy where nothing can translate it.
/// </para>
/// </remarks>
internal static class ItemDigestColumns
{
    /// <summary>How many columns a digest occupies, so a statement's extra columns start here.</summary>
    internal const int Count = 6;

    /// <summary>Reads a digest from the current row's first <see cref="Count"/> columns.</summary>
    /// <param name="reader">The reader, positioned on a row.</param>
    /// <returns>The digest.</returns>
    internal static ItemDigest Read(NpgsqlDataReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);

        return new ItemDigest(
            ItemId.From(reader.GetGuid(0)),
            WorkspaceId.From(reader.GetGuid(1)),
            reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetString(3),
            reader.IsDBNull(4) ? null : ItemId.From(reader.GetGuid(4)),
            reader.GetFieldValue<DateTimeOffset>(5));
    }
}
