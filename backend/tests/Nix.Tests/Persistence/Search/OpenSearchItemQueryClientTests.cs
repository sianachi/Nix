using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Search;

namespace Nix.Tests.Persistence.Search;

public sealed class OpenSearchItemQueryClientTests
{
    private static readonly TenantId Tenant = TenantId.From(
        Guid.Parse("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId WorkspaceOne = WorkspaceId.From(
        Guid.Parse("22222222-2222-4222-8222-222222222222"));
    private static readonly WorkspaceId WorkspaceTwo = WorkspaceId.From(
        Guid.Parse("33333333-3333-4333-8333-333333333333"));
    private static readonly PrincipalId Principal = PrincipalId.From(
        Guid.Parse("44444444-4444-4444-8444-444444444444"));
    private static readonly Guid Item = Guid.Parse("55555555-5555-4555-8555-555555555555");

    [Fact]
    public async Task Query_filters_authorization_and_visibility_before_a_bounded_ranked_limit()
    {
        const string query = "alpha \"}],\"filter\":[{\"match_all\":{}}]";
        using var handler = new RecordingHandler(() => Json(SearchResponse(ValidSource())));
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        var results = await client.FindAsync(
            query,
            [WorkspaceOne, WorkspaceTwo],
            17,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("https://search.example.test/opensearch/nix-items/_search", handler.Target?.AbsoluteUri);
        Assert.Equal("application/json; charset=utf-8", handler.ContentType);
        Assert.Equal("application/json", handler.Accept);
        Assert.NotNull(handler.Body);
        Assert.Contains("authorization_keys", handler.Body, StringComparison.Ordinal);

        using var document = JsonDocument.Parse(handler.Body);
        var root = document.RootElement;
        Assert.Equal(17, root.GetProperty("size").GetInt32());
        Assert.False(root.GetProperty("track_total_hits").GetBoolean());
        Assert.Equal(
            ["tenant_id", "workspace_id", "item_id", "type", "title", "lifecycle_state", "hidden", "deleted"],
            root.GetProperty("_source").EnumerateArray().Select(value => value.GetString()));

        var boolQuery = root.GetProperty("query").GetProperty("bool");
        var filters = boolQuery.GetProperty("filter").EnumerateArray().ToArray();
        Assert.Equal(5, filters.Length);
        Assert.Equal(
            Tenant.ToString(),
            filters[0].GetProperty("term").GetProperty("tenant_id").GetString());
        Assert.Equal(
            [$"workspace:{WorkspaceOne}", $"workspace:{WorkspaceTwo}"],
            filters[1].GetProperty("terms").GetProperty("authorization_keys")
                .EnumerateArray().Select(value => value.GetString()));
        Assert.Equal(
            "active",
            filters[2].GetProperty("term").GetProperty("lifecycle_state").GetString());
        Assert.False(filters[3].GetProperty("term").GetProperty("hidden").GetBoolean());
        Assert.False(filters[4].GetProperty("term").GetProperty("deleted").GetBoolean());

        var matches = boolQuery.GetProperty("should").EnumerateArray().ToArray();
        Assert.Equal(1, boolQuery.GetProperty("minimum_should_match").GetInt32());
        var titleMatch = matches[0].GetProperty("constant_score");
        Assert.Equal(2, titleMatch.GetProperty("boost").GetInt32());
        Assert.Equal(
            query,
            titleMatch.GetProperty("filter").GetProperty("match").GetProperty("title")
                .GetProperty("query").GetString());
        var contentMatch = matches[1].GetProperty("constant_score");
        Assert.Equal(1, contentMatch.GetProperty("boost").GetInt32());
        Assert.Equal(
            ["body", "property_text"],
            contentMatch.GetProperty("filter").GetProperty("multi_match").GetProperty("fields")
                .EnumerateArray().Select(value => value.GetString()));

        var sort = root.GetProperty("sort").EnumerateArray().ToArray();
        Assert.Equal("desc", sort[0].GetProperty("_score").GetProperty("order").GetString());
        Assert.Equal("asc", sort[1].GetProperty("item_id").GetProperty("order").GetString());

        var digest = Assert.Single(results);
        Assert.Equal(Item, digest.Id.Value);
        Assert.Equal(WorkspaceOne, digest.WorkspaceId);
        Assert.Equal("note", digest.Type);
        Assert.Equal("Alpha plan", digest.Title);
    }

    [Fact]
    public async Task Empty_readable_workspace_scope_returns_nothing_without_contacting_OpenSearch()
    {
        using var handler = new RecordingHandler(() => throw new InvalidOperationException("Unexpected request."));
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        var results = await client.FindAsync(
            "alpha",
            [],
            20,
            TestContext.Current.CancellationToken);

        Assert.Empty(results);
        Assert.Equal(0, handler.Requests);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("{}")]
    [InlineData("{\"hits\":{\"hits\":null}}")]
    [InlineData("{\"hits\":{\"hits\":[{\"_source\":null}]}}")]
    public async Task Malformed_response_envelopes_are_refused(string payload)
    {
        using var handler = new RecordingHandler(() => Json(payload));
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FindAsync(
            "alpha",
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Declared_and_streamed_oversized_responses_are_refused(bool declaresLength)
    {
        var payload = new string('x', (60 * 1024) + 1);
        using var handler = new RecordingHandler(() => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = declaresLength
                ? new StringContent(payload, Encoding.UTF8, "application/json")
                : new UnknownLengthContent(payload),
        });
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FindAsync(
            "alpha",
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());
    }

    [Fact]
    public async Task Non_success_status_is_returned_as_an_HTTP_failure_without_parsing_the_body()
    {
        using var handler = new RecordingHandler(() => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
        {
            Content = new StringContent("not json", Encoding.UTF8, "text/plain"),
        });
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        var exception = await Assert.ThrowsAsync<HttpRequestException>(() => client.FindAsync(
            "alpha",
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(HttpStatusCode.ServiceUnavailable, exception.StatusCode);
    }

    [Fact]
    public async Task Caller_cancellation_interrupts_an_in_flight_query()
    {
        using var handler = new BlockingHandler();
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient, TimeSpan.FromSeconds(10));
        using var cancellation = new CancellationTokenSource();

        var query = client.FindAsync("alpha", [WorkspaceOne], 20, cancellation.Token).AsTask();
        await handler.Started.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => query);
    }

    [Fact]
    public async Task Client_deadline_covers_the_complete_OpenSearch_exchange()
    {
        using var handler = new BlockingHandler();
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient, TimeSpan.FromMilliseconds(25));

        await Assert.ThrowsAsync<TimeoutException>(() => client.FindAsync(
            "alpha",
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());
    }

    [Theory]
    [InlineData("tenant")]
    [InlineData("workspace")]
    [InlineData("item")]
    [InlineData("type")]
    [InlineData("title")]
    [InlineData("lifecycle")]
    [InlineData("hidden")]
    [InlineData("deleted")]
    public async Task Cross_scope_and_malformed_hits_are_refused_as_a_whole(string corruption)
    {
        var source = ValidSource();
        switch (corruption)
        {
            case "tenant":
                source["tenant_id"] = "66666666-6666-4666-8666-666666666666";
                break;
            case "workspace":
                source["workspace_id"] = WorkspaceTwo.ToString();
                break;
            case "item":
                source["item_id"] = "not-a-uuid";
                break;
            case "type":
                source["type"] = " ";
                break;
            case "title":
                source.Remove("title");
                break;
            case "lifecycle":
                source["lifecycle_state"] = "deleted";
                break;
            case "hidden":
                source["hidden"] = true;
                break;
            case "deleted":
                source["deleted"] = true;
                break;
        }

        using var handler = new RecordingHandler(() => Json(SearchResponse(source)));
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.FindAsync(
            "alpha",
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());
    }

    [Fact]
    public async Task Serialized_request_bound_is_enforced_after_JSON_escaping()
    {
        using var handler = new RecordingHandler(() => Json(SearchResponse(ValidSource())));
        using var httpClient = HttpClientOver(handler);
        var client = SearchClient(httpClient);
        var escapeHeavyQuery = new string('\u0001', 4 * 1024);

        await Assert.ThrowsAsync<ArgumentException>(() => client.FindAsync(
            escapeHeavyQuery,
            [WorkspaceOne],
            20,
            TestContext.Current.CancellationToken).AsTask());
        Assert.Equal(0, handler.Requests);
    }

    private static OpenSearchItemQueryClient SearchClient(
        HttpClient httpClient,
        TimeSpan? timeout = null) =>
        new(httpClient, new StubSession(), "nix-items", timeout);

    private static HttpClient HttpClientOver(HttpMessageHandler handler) => new(handler)
    {
        BaseAddress = new Uri("https://search.example.test/opensearch/"),
        Timeout = Timeout.InfiniteTimeSpan,
    };

    private static JsonObject ValidSource() => new()
    {
        ["tenant_id"] = Tenant.ToString(),
        ["workspace_id"] = WorkspaceOne.ToString(),
        ["item_id"] = Item.ToString("D"),
        ["type"] = "note",
        ["title"] = "Alpha plan",
        ["lifecycle_state"] = "active",
        ["hidden"] = false,
        ["deleted"] = false,
    };

    private static string SearchResponse(JsonObject source) => new JsonObject
    {
        ["took"] = 1,
        ["hits"] = new JsonObject
        {
            ["total"] = new JsonObject { ["value"] = 1, ["relation"] = "eq" },
            ["hits"] = new JsonArray
            {
                new JsonObject
                {
                    ["_index"] = "nix-items-000001",
                    ["_score"] = 2,
                    ["_source"] = source,
                },
            },
        },
    }.ToJsonString();

    private static HttpResponseMessage Json(string payload) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(payload, Encoding.UTF8, "application/json"),
    };

    private sealed class StubSession : INixSessionContextAccessor
    {
        public NixSessionContext? Current => NixSessionContext.ForTenant(Tenant, Principal);
    }

    private sealed class RecordingHandler(Func<HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Requests { get; private set; }

        public HttpMethod? Method { get; private set; }

        public Uri? Target { get; private set; }

        public string? ContentType { get; private set; }

        public string? Accept { get; private set; }

        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            Method = request.Method;
            Target = request.RequestUri;
            ContentType = request.Content?.Headers.ContentType?.ToString();
            Accept = request.Headers.Accept.SingleOrDefault()?.MediaType;
            Body = request.Content is null
                ? null
                : await request.Content.ReadAsStringAsync(cancellationToken);
            return respond();
        }
    }

    private sealed class BlockingHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<bool> _started = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Started => _started.Task;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _started.TrySetResult(true);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return Json(SearchResponse(ValidSource()));
        }
    }

    private sealed class UnknownLengthContent(string payload) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(Encoding.UTF8.GetBytes(payload)).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
