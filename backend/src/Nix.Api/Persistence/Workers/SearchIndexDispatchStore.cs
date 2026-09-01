using System.Buffers;
using System.Data;
using System.Text;
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Workers;

/// <summary>
/// Reads one current search projection at a time through exact security-definer functions.
/// </summary>
/// <remarks>
/// This store is intentionally cross-tenant and correspondingly narrow: the Rabbit event supplies
/// both identifiers, the internal boundary authenticates the caller, and neither query can list or
/// search the corpus. Large body text stays streamed and never becomes a Core <see cref="string"/>.
/// </remarks>
public sealed class SearchIndexDispatchStore(NpgsqlDataSource dataSource)
{
    private const string MetadataSql = "SELECT * FROM nix_read_search_index_metadata(@tenant_id, @item_id)";
    private const string BodySql = "SELECT * FROM nix_read_search_index_body(@tenant_id, @item_id)";
    private const string RebuildSql = "SELECT * FROM nix_enqueue_search_rebuild_page(@after_tenant_id, @after_item_id, @updated_since, @limit)";
    private const string StatusSql = "SELECT * FROM nix_search_index_outbox_status()";

    /// <summary>Reads the bounded metadata for one exact tenant/item pair.</summary>
    public async ValueTask<SearchIndexMetadataRecord?> GetMetadataAsync(
        Guid tenantId,
        Guid itemId,
        CancellationToken cancellationToken)
    {
        if (tenantId == Guid.Empty || itemId == Guid.Empty)
        {
            return null;
        }

        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(MetadataSql, connection);
            await using (command.ConfigureAwait(false))
            {
                AddIdentityParameters(command, tenantId, itemId);
                var reader = await command.ExecuteReaderAsync(
                    CommandBehavior.SingleRow,
                    cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }

                    using var properties = JsonDocument.Parse(
                        reader.GetString(7),
                        new JsonDocumentOptions { MaxDepth = 16 });
                    return new SearchIndexMetadataRecord(
                        reader.GetGuid(0),
                        reader.GetGuid(1),
                        reader.GetGuid(2),
                        await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetGuid(3),
                        reader.GetString(4),
                        await reader.IsDBNullAsync(5, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetString(5),
                        reader.GetString(6),
                        properties.RootElement.Clone(),
                        await reader.GetFieldValueAsync<Guid[]>(8, cancellationToken)
                            .ConfigureAwait(false),
                        await reader.GetFieldValueAsync<Guid[]>(9, cancellationToken)
                            .ConfigureAwait(false),
                        await reader.GetFieldValueAsync<string[]>(10, cancellationToken)
                            .ConfigureAwait(false),
                        reader.GetString(11),
                        reader.GetBoolean(12),
                        await reader.GetFieldValueAsync<DateTimeOffset>(13, cancellationToken)
                            .ConfigureAwait(false));
                }
            }
        }
    }

    /// <summary>Opens a sequential reader for one item's bounded derived body text.</summary>
    public async ValueTask<SearchIndexBodyLease?> OpenBodyAsync(
        Guid tenantId,
        Guid itemId,
        CancellationToken cancellationToken)
    {
        if (tenantId == Guid.Empty || itemId == Guid.Empty)
        {
            return null;
        }

        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var command = new NpgsqlCommand(BodySql, connection);
            AddIdentityParameters(command, tenantId, itemId);
            var reader = await command.ExecuteReaderAsync(
                CommandBehavior.SequentialAccess | CommandBehavior.SingleRow,
                cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                await reader.DisposeAsync().ConfigureAwait(false);
                await command.DisposeAsync().ConfigureAwait(false);
                await connection.DisposeAsync().ConfigureAwait(false);
                return null;
            }

            var hasBody = !await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false);
            return new SearchIndexBodyLease(connection, command, reader, hasBody);
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>Durably enqueues one bounded, restartable rebuild page.</summary>
    public async ValueTask<SearchIndexRebuildPage> EnqueueRebuildPageAsync(
        Guid? afterTenantId,
        Guid? afterItemId,
        DateTimeOffset? updatedSince,
        int limit,
        CancellationToken cancellationToken)
    {
        if ((afterTenantId is null) != (afterItemId is null)
            || afterTenantId == Guid.Empty
            || afterItemId == Guid.Empty
            || updatedSince == DateTimeOffset.MinValue
            || limit is < 1 or > 1000)
        {
            throw new ArgumentException("The search rebuild cursor or limit is invalid.");
        }

        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(RebuildSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(NullableUuid("after_tenant_id", afterTenantId));
                command.Parameters.Add(NullableUuid("after_item_id", afterItemId));
                command.Parameters.Add(new NpgsqlParameter<DateTimeOffset?>("updated_since", NpgsqlDbType.TimestampTz)
                {
                    TypedValue = updatedSince,
                });
                command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer)
                {
                    TypedValue = limit,
                });
                var reader = await command.ExecuteReaderAsync(
                    CommandBehavior.SingleRow,
                    cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("The search rebuild function returned no result.");
                    }

                    return new SearchIndexRebuildPage(
                        reader.GetInt32(0),
                        await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetGuid(1),
                        await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetGuid(2),
                        reader.GetBoolean(3));
                }
            }
        }
    }

    /// <summary>Reads bounded durable queue lag and failure counters.</summary>
    public async ValueTask<SearchIndexOutboxStatus> GetOutboxStatusAsync(
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(StatusSql, connection);
            await using (command.ConfigureAwait(false))
            {
                var reader = await command.ExecuteReaderAsync(
                    CommandBehavior.SingleRow,
                    cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("The search index status function returned no result.");
                    }

                    return new SearchIndexOutboxStatus(
                        reader.GetInt64(0),
                        await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                            ? null
                            : await reader.GetFieldValueAsync<DateTimeOffset>(1, cancellationToken)
                                .ConfigureAwait(false),
                        reader.GetInt32(2),
                        reader.GetInt64(3));
                }
            }
        }
    }

    private static void AddIdentityParameters(NpgsqlCommand command, Guid tenantId, Guid itemId)
    {
        command.Parameters.Add(new NpgsqlParameter<Guid>("tenant_id", NpgsqlDbType.Uuid)
        {
            TypedValue = tenantId,
        });
        command.Parameters.Add(new NpgsqlParameter<Guid>("item_id", NpgsqlDbType.Uuid)
        {
            TypedValue = itemId,
        });
    }

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is null ? DBNull.Value : value.Value };
}

/// <summary>The bounded metadata half of one OpenSearch document.</summary>
public sealed record SearchIndexMetadataRecord(
    Guid TenantId,
    Guid WorkspaceId,
    Guid ItemId,
    Guid? ParentId,
    string ItemType,
    string? Title,
    string PropertyText,
    JsonElement Properties,
    IReadOnlyList<Guid> AncestorIds,
    IReadOnlyList<Guid> Links,
    IReadOnlyList<string> AuthorizationKeys,
    string LifecycleState,
    bool Indexable,
    DateTimeOffset SourceUpdatedAt);

/// <summary>One durable page of a full or time-bounded index rebuild.</summary>
public sealed record SearchIndexRebuildPage(
    int Enqueued,
    Guid? NextTenantId,
    Guid? NextItemId,
    bool HasMore);

/// <summary>Durable Postgres-to-Rabbit index publication lag.</summary>
public sealed record SearchIndexOutboxStatus(
    long Pending,
    DateTimeOffset? OldestAvailableAt,
    int HighestAttempts,
    long PendingFailures);

/// <summary>Owns the connection and sequential reader while one body is copied to the response.</summary>
public sealed class SearchIndexBodyLease : IAsyncDisposable
{
    private readonly NpgsqlConnection connection;
    private readonly NpgsqlCommand command;
    private readonly NpgsqlDataReader reader;
    private bool disposed;

    internal SearchIndexBodyLease(
        NpgsqlConnection connection,
        NpgsqlCommand command,
        NpgsqlDataReader reader,
        bool hasBody)
    {
        this.connection = connection;
        this.command = command;
        this.reader = reader;
        HasBody = hasBody;
    }

    /// <summary>Whether an item currently has materialized body text.</summary>
    public bool HasBody { get; }

    /// <summary>Streams UTF-8 body text with a small pooled buffer.</summary>
    public async ValueTask CopyToAsync(Stream destination, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(destination);
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!HasBody)
        {
            return;
        }

        using var source = await reader.GetTextReaderAsync(1, cancellationToken)
            .ConfigureAwait(false);
        var writer = new StreamWriter(
            destination,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            bufferSize: 4096,
            leaveOpen: true);
        await using (writer.ConfigureAwait(false))
        {
            var buffer = ArrayPool<char>.Shared.Rent(4096);
            try
            {
                while (true)
                {
                    var read = await source.ReadAsync(buffer.AsMemory(0, 4096), cancellationToken)
                        .ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    await writer.WriteAsync(buffer.AsMemory(0, read), cancellationToken)
                        .ConfigureAwait(false);
                }

                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                ArrayPool<char>.Shared.Return(buffer, clearArray: true);
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        await reader.DisposeAsync().ConfigureAwait(false);
        await command.DisposeAsync().ConfigureAwait(false);
        await connection.DisposeAsync().ConfigureAwait(false);
    }
}
