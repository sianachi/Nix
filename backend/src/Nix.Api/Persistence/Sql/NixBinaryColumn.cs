using Npgsql;

namespace Nix.Persistence.Sql;

/// <summary>
/// A live stream over one <c>bytea</c> column, plus the reader and command keeping it open.
/// </summary>
/// <remarks>
/// <para>
/// Exists so that binary payloads - <c>content_update.update_bytes</c> above all - are read off
/// the wire in chunks instead of being materialised. The alternative, <c>GetFieldValue&lt;byte[]&gt;</c>,
/// allocates the whole payload at once; anything over 85 KB lands on the large object heap, and
/// the update log is exactly the place where that happens at request rate.
/// </para>
/// <para>
/// The consumer owns the lifetime: read <see cref="Value"/> to completion (or stop early), then
/// dispose. Disposing releases the reader and the command, in that order. Until then the
/// transaction it was opened on stays busy, so do not hold one across unrelated work.
/// </para>
/// </remarks>
public sealed class NixBinaryColumn : IAsyncDisposable
{
    private readonly NpgsqlCommand _command;
    private readonly NpgsqlDataReader _reader;

    internal NixBinaryColumn(NpgsqlCommand command, NpgsqlDataReader reader, Stream value)
    {
        _command = command;
        _reader = reader;
        Value = value;
    }

    /// <summary>
    /// Gets the forward-only stream over the column's bytes.
    /// </summary>
    public Stream Value { get; }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        await Value.DisposeAsync().ConfigureAwait(false);
        await _reader.DisposeAsync().ConfigureAwait(false);
        await _command.DisposeAsync().ConfigureAwait(false);
    }
}
