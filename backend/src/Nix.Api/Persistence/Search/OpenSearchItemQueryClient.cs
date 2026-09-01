using System.Buffers;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Search;

/// <summary>Runs bounded, authorization-scoped item searches against OpenSearch.</summary>
/// <remarks>
/// The tenant comes from the authenticated server session and authorization keys are derived from
/// the workspace set returned by the server's permission resolver. The public surface deliberately
/// accepts neither arbitrary query DSL nor authorization keys, so a browser request cannot replace
/// either mandatory filter.
/// </remarks>
public sealed class OpenSearchItemQueryClient
{
    private const int MaximumQueryBytes = 4 * 1024;
    private const int MaximumRequestBytes = 32 * 1024;
    private const int MaximumResponseBytes = 60 * 1024;
    private const int MaximumReadableWorkspaces = 512;
    private const int MaximumResults = 100;
    private const int MaximumTypeBytes = 256;
    private const int MaximumTitleBytes = 8 * 1024;
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaximumTimeout = TimeSpan.FromSeconds(30);
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly OpenSearchItemQueryJsonContext ResponseJson = new(
        new JsonSerializerOptions
        {
            AllowTrailingCommas = false,
            MaxDepth = 16,
            PropertyNameCaseInsensitive = false,
            ReadCommentHandling = JsonCommentHandling.Disallow,
        });

    private readonly HttpClient _httpClient;
    private readonly INixSessionContextAccessor _session;
    private readonly Uri _searchEndpoint;
    private readonly TimeSpan _timeout;

    /// <summary>Initializes a bounded client over an injected OpenSearch HTTP transport.</summary>
    /// <param name="httpClient">
    /// A client whose base address and transport authentication are configured by the host.
    /// </param>
    /// <param name="session">The authenticated tenant context for the current server request.</param>
    /// <param name="indexName">The exact index or read-alias name; wildcards are not accepted.</param>
    /// <param name="timeout">An optional per-query deadline. The default is two seconds.</param>
    public OpenSearchItemQueryClient(
        HttpClient httpClient,
        INixSessionContextAccessor session,
        string indexName,
        TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(session);

        _httpClient = httpClient;
        _session = session;
        _timeout = timeout ?? DefaultTimeout;
        if (_timeout <= TimeSpan.Zero || _timeout > MaximumTimeout)
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeout),
                $"The timeout must be positive and no longer than {MaximumTimeout.TotalSeconds} seconds.");
        }

        var baseAddress = httpClient.BaseAddress
            ?? throw new ArgumentException("The OpenSearch HttpClient requires a base address.", nameof(httpClient));
        if (!baseAddress.IsAbsoluteUri
            || (baseAddress.Scheme != Uri.UriSchemeHttp && baseAddress.Scheme != Uri.UriSchemeHttps)
            || baseAddress.UserInfo.Length != 0
            || baseAddress.Query.Length != 0
            || baseAddress.Fragment.Length != 0)
        {
            throw new ArgumentException("The OpenSearch base address is not a safe HTTP origin.", nameof(httpClient));
        }

        ValidateIndexName(indexName);
        var root = new Uri(baseAddress.AbsoluteUri.TrimEnd('/') + "/", UriKind.Absolute);
        _searchEndpoint = new Uri(root, Uri.EscapeDataString(indexName) + "/_search");
    }

    /// <summary>Finds readable active items, ordered by title match, score, and item identity.</summary>
    /// <param name="query">The user's search text, never query DSL.</param>
    /// <param name="serverResolvedReadableWorkspaces">
    /// The readable workspaces returned by the server's permission resolver. This value must not
    /// be bound directly from a client request.
    /// </param>
    /// <param name="limit">The maximum number of digests to return, from one through one hundred.</param>
    /// <param name="cancellationToken">Cancels the outbound request and response read.</param>
    /// <returns>Validated item digests that remain inside the supplied authorization scope.</returns>
    public async ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> serverResolvedReadableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(serverResolvedReadableWorkspaces);
        cancellationToken.ThrowIfCancellationRequested();

        ValidateQuery(query);
        if (limit is < 1 or > MaximumResults)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), $"The limit must be between 1 and {MaximumResults}.");
        }

        if (serverResolvedReadableWorkspaces.Count == 0)
        {
            return [];
        }

        var workspaces = SnapshotWorkspaces(serverResolvedReadableWorkspaces);
        var context = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this OpenSearch query.");
        if (!context.IsComplete || context.TenantId.Value == Guid.Empty)
        {
            throw new InvalidOperationException(
                "The session context is incomplete for this OpenSearch query.");
        }

        // byte[]: HttpContent needs stable storage until SendAsync has consumed the bounded JSON.
        var requestBody = BuildRequest(context.TenantId, workspaces, query, limit);
        using var request = new HttpRequestMessage(HttpMethod.Post, _searchEndpoint)
        {
            Content = new ByteArrayContent(requestBody),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json")
        {
            CharSet = "utf-8",
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(_timeout);
        try
        {
            using var response = await _httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                deadline.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException(
                    "OpenSearch refused the item query.",
                    inner: null,
                    response.StatusCode);
            }

            return await ReadAndValidateAsync(
                response.Content,
                context.TenantId,
                workspaces,
                limit,
                deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("OpenSearch did not complete the item query before its deadline.", exception);
        }
    }

    private static void ValidateQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            throw new ArgumentException("Search text is required.", nameof(query));
        }

        try
        {
            if (StrictUtf8.GetByteCount(query) > MaximumQueryBytes)
            {
                throw new ArgumentException(
                    $"Search text may not exceed {MaximumQueryBytes} UTF-8 bytes.",
                    nameof(query));
            }
        }
        catch (EncoderFallbackException exception)
        {
            throw new ArgumentException("Search text must contain valid Unicode.", nameof(query), exception);
        }
    }

    private static Guid[] SnapshotWorkspaces(IReadOnlyList<WorkspaceId> readableWorkspaces)
    {
        if (readableWorkspaces.Count > MaximumReadableWorkspaces)
        {
            throw new ArgumentException(
                $"At most {MaximumReadableWorkspaces} readable workspaces may be searched at once.",
                nameof(readableWorkspaces));
        }

        var unique = new HashSet<Guid>();
        var values = new List<Guid>(readableWorkspaces.Count);
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            var value = readableWorkspaces[index].Value;
            if (value == Guid.Empty)
            {
                throw new ArgumentException(
                    "Readable workspace identifiers must not be empty.",
                    nameof(readableWorkspaces));
            }

            if (unique.Add(value))
            {
                values.Add(value);
            }
        }

        return [.. values];
    }

    private static byte[] BuildRequest(
        TenantId tenantId,
        Guid[] workspaces,
        string query,
        int limit)
    {
        using var buffer = new BoundedBufferWriter(MaximumRequestBytes);
        try
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteNumber("size", limit);
                writer.WriteBoolean("track_total_hits", false);

                writer.WriteStartArray("_source");
                writer.WriteStringValue("tenant_id");
                writer.WriteStringValue("workspace_id");
                writer.WriteStringValue("item_id");
                writer.WriteStringValue("type");
                writer.WriteStringValue("title");
                writer.WriteStringValue("lifecycle_state");
                writer.WriteStringValue("hidden");
                writer.WriteStringValue("deleted");
                writer.WriteEndArray();

                writer.WriteStartObject("query");
                writer.WriteStartObject("bool");
                writer.WriteStartArray("filter");
                WriteTerm(writer, "tenant_id", tenantId.ToString());
                WriteAuthorizationTerms(writer, workspaces);
                WriteTerm(writer, "lifecycle_state", "active");
                WriteTerm(writer, "hidden", false);
                WriteTerm(writer, "deleted", false);
                writer.WriteEndArray();

                writer.WriteStartArray("should");
                WriteTitleMatch(writer, query);
                WriteContentMatch(writer, query);
                writer.WriteEndArray();
                writer.WriteNumber("minimum_should_match", 1);
                writer.WriteEndObject();
                writer.WriteEndObject();

                writer.WriteStartArray("sort");
                WriteSort(writer, "_score", "desc");
                WriteSort(writer, "item_id", "asc");
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
        }
        catch (InvalidOperationException exception) when (buffer.CapacityExceeded)
        {
            throw new ArgumentException(
                $"The serialized OpenSearch query exceeds {MaximumRequestBytes} bytes.",
                nameof(query),
                exception);
        }

        // byte[]: ByteArrayContent owns a stable, exactly-sized request body across the await.
        return buffer.WrittenSpan.ToArray();
    }

    private static void WriteTerm(Utf8JsonWriter writer, string field, string value)
    {
        writer.WriteStartObject();
        writer.WriteStartObject("term");
        writer.WriteString(field, value);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteTerm(Utf8JsonWriter writer, string field, bool value)
    {
        writer.WriteStartObject();
        writer.WriteStartObject("term");
        writer.WriteBoolean(field, value);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteAuthorizationTerms(Utf8JsonWriter writer, Guid[] workspaces)
    {
        writer.WriteStartObject();
        writer.WriteStartObject("terms");
        writer.WriteStartArray("authorization_keys");
        for (var index = 0; index < workspaces.Length; index++)
        {
            writer.WriteStringValue(string.Concat("workspace:", workspaces[index].ToString("D")));
        }

        writer.WriteEndArray();
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteTitleMatch(Utf8JsonWriter writer, string query)
    {
        writer.WriteStartObject();
        writer.WriteStartObject("constant_score");
        writer.WriteNumber("boost", 2);
        writer.WriteStartObject("filter");
        writer.WriteStartObject("match");
        writer.WriteStartObject("title");
        writer.WriteString("query", query);
        writer.WriteString("operator", "and");
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteContentMatch(Utf8JsonWriter writer, string query)
    {
        writer.WriteStartObject();
        writer.WriteStartObject("constant_score");
        writer.WriteNumber("boost", 1);
        writer.WriteStartObject("filter");
        writer.WriteStartObject("multi_match");
        writer.WriteString("query", query);
        writer.WriteStartArray("fields");
        writer.WriteStringValue("body");
        writer.WriteStringValue("property_text");
        writer.WriteEndArray();
        writer.WriteString("type", "best_fields");
        writer.WriteString("operator", "and");
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteSort(Utf8JsonWriter writer, string field, string order)
    {
        writer.WriteStartObject();
        writer.WriteStartObject(field);
        writer.WriteString("order", order);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static async ValueTask<IReadOnlyList<ItemDigest>> ReadAndValidateAsync(
        HttpContent content,
        TenantId tenantId,
        IReadOnlyList<Guid> workspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is > MaximumResponseBytes)
        {
            throw new InvalidDataException(
                $"The OpenSearch response exceeded {MaximumResponseBytes} bytes.");
        }

        var bytes = ArrayPool<byte>.Shared.Rent(MaximumResponseBytes + 1);
        try
        {
            var length = await ReadBoundedAsync(content, bytes, cancellationToken).ConfigureAwait(false);
            OpenSearchResponseEnvelope? envelope;
            try
            {
                envelope = JsonSerializer.Deserialize(
                    bytes.AsSpan(0, length),
                    ResponseJson.OpenSearchResponseEnvelope);
            }
            catch (JsonException exception)
            {
                throw new InvalidDataException("OpenSearch returned malformed search JSON.", exception);
            }

            if (envelope?.Hits?.Hits is not { } hits || hits.Length > limit)
            {
                throw new InvalidDataException("OpenSearch returned an invalid number of search hits.");
            }

            return ValidateHits(hits, tenantId, workspaces);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(bytes, clearArray: true);
        }
    }

    private static async ValueTask<int> ReadBoundedAsync(
        HttpContent content,
        byte[] destination,
        CancellationToken cancellationToken)
    {
        var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var total = 0;
            while (total <= MaximumResponseBytes)
            {
                var read = await stream.ReadAsync(
                    destination.AsMemory(total, MaximumResponseBytes + 1 - total),
                    cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return total;
                }

                total += read;
            }
        }

        throw new InvalidDataException(
            $"The OpenSearch response exceeded {MaximumResponseBytes} bytes.");
    }

    private static List<ItemDigest> ValidateHits(
        OpenSearchHit[] hits,
        TenantId tenantId,
        IReadOnlyList<Guid> workspaces)
    {
        var readable = new HashSet<Guid>(workspaces);
        var seenItems = new HashSet<Guid>();
        var digests = new List<ItemDigest>(hits.Length);
        for (var index = 0; index < hits.Length; index++)
        {
            var source = hits[index].Source
                ?? throw new InvalidDataException("An OpenSearch hit has no source document.");
            if (!TryGuid(source.TenantId, out var returnedTenant) || returnedTenant != tenantId.Value)
            {
                throw new InvalidDataException("An OpenSearch hit escaped the tenant query scope.");
            }

            if (!TryGuid(source.WorkspaceId, out var workspaceId) || !readable.Contains(workspaceId))
            {
                throw new InvalidDataException("An OpenSearch hit escaped the workspace query scope.");
            }

            if (!TryGuid(source.ItemId, out var itemId) || !seenItems.Add(itemId))
            {
                throw new InvalidDataException("An OpenSearch hit has an invalid or duplicate item identifier.");
            }

            if (!IsValidType(source.Type)
                || !IsValidTitle(source.Title)
                || !string.Equals(source.LifecycleState, "active", StringComparison.Ordinal)
                || source.Hidden is not false
                || source.Deleted is not false)
            {
                throw new InvalidDataException("An OpenSearch hit has invalid digest or visibility fields.");
            }

            digests.Add(new ItemDigest(
                ItemId.From(itemId),
                WorkspaceId.From(workspaceId),
                source.Type!,
                source.Title));
        }

        return digests;
    }

    private static bool TryGuid(string? value, out Guid identifier) =>
        Guid.TryParseExact(value, "D", out identifier) && identifier != Guid.Empty;

    private static bool IsValidType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || !IsBoundedUtf8(value, MaximumTypeBytes))
        {
            return false;
        }

        for (var index = 0; index < value.Length; index++)
        {
            if (char.IsControl(value[index]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsValidTitle(string? value) =>
        value is null || IsBoundedUtf8(value, MaximumTitleBytes);

    private static bool IsBoundedUtf8(string value, int maximumBytes)
    {
        try
        {
            return StrictUtf8.GetByteCount(value) <= maximumBytes;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }

    internal static void ValidateIndexName(string indexName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(indexName);
        if (indexName is "." or ".."
            || indexName.Length > 255
            || indexName[0] is '_' or '-' or '+'
            || !IsSafeIndexName(indexName))
        {
            throw new ArgumentException("The OpenSearch index name is invalid.", nameof(indexName));
        }
    }

    private static bool IsSafeIndexName(string indexName)
    {
        for (var index = 0; index < indexName.Length; index++)
        {
            var character = indexName[index];
            if (!((character is >= 'a' and <= 'z')
                || char.IsAsciiDigit(character)
                || character is '-' or '_' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Keeps request serialization inside one pooled, fixed-size buffer.</summary>
    private sealed class BoundedBufferWriter : IBufferWriter<byte>, IDisposable
    {
        private readonly int _maximumBytes;
        private byte[]? _buffer;
        private int _written;

        internal BoundedBufferWriter(int maximumBytes)
        {
            _maximumBytes = maximumBytes;
            _buffer = ArrayPool<byte>.Shared.Rent(maximumBytes);
        }

        internal bool CapacityExceeded { get; private set; }

        internal ReadOnlySpan<byte> WrittenSpan =>
            (_buffer ?? throw new ObjectDisposedException(nameof(BoundedBufferWriter)))
            .AsSpan(0, _written);

        public void Advance(int count)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(count);
            if (count > _maximumBytes - _written)
            {
                ThrowCapacityExceeded();
            }

            _written += count;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            var buffer = _buffer ?? throw new ObjectDisposedException(nameof(BoundedBufferWriter));
            ArgumentOutOfRangeException.ThrowIfNegative(sizeHint);
            var required = Math.Max(sizeHint, 1);
            if (required > _maximumBytes - _written)
            {
                ThrowCapacityExceeded();
            }

            return buffer.AsMemory(_written, _maximumBytes - _written);
        }

        public Span<byte> GetSpan(int sizeHint = 0) => GetMemory(sizeHint).Span;

        public void Dispose()
        {
            var buffer = Interlocked.Exchange(ref _buffer, null);
            if (buffer is not null)
            {
                ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
            }
        }

        private void ThrowCapacityExceeded()
        {
            CapacityExceeded = true;
            throw new InvalidOperationException("The fixed JSON buffer is full.");
        }
    }
}
