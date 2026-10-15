using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Conversations;

namespace Nix.Tests.Features.Conversations;

public sealed class ConversationBodyReaderTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Reads_prose_and_forwards_the_persisted_turn_and_scoped_actor()
    {
        using var handler = new BodyHandler(HttpStatusCode.OK, new ConversationBody("A saved insight", true, false));
        using var http = new HttpClient(handler);
        var session = new Session();
        var reader = new ConversationBodyReader(http, Configuration(), session);
        var conversation = Guid.NewGuid();
        var request = Guid.NewGuid();
        var workspace = Guid.NewGuid();
        var item = Guid.NewGuid();

        var result = await reader.ReadAsync(conversation, request, workspace, item, Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(new ConversationBody("A saved insight", true, false), result.Value);
        Assert.Equal($"/internal/conversations/{conversation:D}/body", handler.Path);
        using var payload = JsonDocument.Parse(handler.Payload!);
        Assert.Equal(session.Current!.Value.TenantId.Value, payload.RootElement.GetProperty("tenantId").GetGuid());
        Assert.Equal(session.Current.Value.PrincipalId.Value, payload.RootElement.GetProperty("principalId").GetGuid());
        Assert.Equal(request, payload.RootElement.GetProperty("requestId").GetGuid());
        Assert.Equal(workspace, payload.RootElement.GetProperty("workspaceId").GetGuid());
        Assert.Equal(item, payload.RootElement.GetProperty("itemId").GetGuid());
        Assert.Equal("test-secret", handler.Secret);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, "conversations.body_locked")]
    [InlineData(HttpStatusCode.NotFound, "conversations.source_unavailable")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "conversations.body_unavailable")]
    public async Task Refusals_are_not_reported_as_empty_successful_bodies(HttpStatusCode status, string code)
    {
        using var handler = new BodyHandler(status, new ConversationBody("", false, false));
        using var http = new HttpClient(handler);
        var reader = new ConversationBodyReader(http, Configuration(), new Session());
        var result = await reader.ReadAsync(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal(code, result.Error.Code);
    }

    [Fact]
    public async Task Rejects_a_response_that_exceeds_the_prose_limit()
    {
        using var handler = new BodyHandler(HttpStatusCode.OK, new ConversationBody(new string('x', 24_001), false, false));
        using var http = new HttpClient(handler);
        var reader = new ConversationBodyReader(http, Configuration(), new Session());
        var result = await reader.ReadAsync(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal("conversations.body_unavailable", result.Error.Code);
    }

    private static IConfiguration Configuration() => new ConfigurationBuilder().AddInMemoryCollection(
        new Dictionary<string, string?>
        {
            ["Nix:InternalSecret"] = "test-secret",
            ["Nix:Collaboration:BaseUrl"] = "http://localhost:8100"
        }).Build();

    private sealed class Session : INixSessionContextAccessor
    {
        public NixSessionContext? Current { get; } = NixSessionContext.ForTenant(
            new TenantId(Guid.NewGuid()), new PrincipalId(Guid.NewGuid()));
    }

    private sealed class BodyHandler(HttpStatusCode status, ConversationBody body) : HttpMessageHandler
    {
        public string? Path { get; private set; }
        public string? Payload { get; private set; }
        public string? Secret { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Path = request.RequestUri!.AbsolutePath;
            Payload = await request.Content!.ReadAsStringAsync(cancellationToken);
            Secret = request.Headers.GetValues("x-nix-internal-secret").Single();
            return new HttpResponseMessage(status) { Content = JsonContent.Create(body) };
        }
    }
}
