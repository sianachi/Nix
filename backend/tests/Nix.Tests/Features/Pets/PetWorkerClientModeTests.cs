using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Workspaces;

namespace Nix.Tests.Features.Pets;

public sealed class PetWorkerClientModeTests
{
    private static readonly Guid WorkspaceGuid = new("44444444-4444-4444-8444-444444444444");
    private static readonly Guid PetGuid = new("55555555-5555-4555-8555-555555555555");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_unknown_mode_is_refused_as_pets_invalid_request()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteAsync(new("status", Mode: "design"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task Consult_is_forwarded_to_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Design a habit tracker", Mode: "consult"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("consult", body.RootElement.GetProperty("mode").GetString());
    }

    [Fact]
    public async Task A_watch_operation_posted_through_ExecuteAsync_is_refused_before_reaching_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteAsync(new("watch", WorkspaceGuid, PetGuid), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task ExecuteWatchAsync_reaches_the_worker_with_the_watch_operation_and_after_value()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 42, Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("watch", body.RootElement.GetProperty("operation").GetString());
        Assert.Equal("chat", body.RootElement.GetProperty("mode").GetString());
        Assert.Equal(42, body.RootElement.GetProperty("after").GetInt64());
    }

    [Fact]
    public async Task ExecuteWatchAsync_is_refused_exactly_like_read_for_a_foreign_workspace()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new DenyReadPermissions());

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 0, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.not_found", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_429_from_the_worker_is_mapped_to_pets_too_many_watches_and_HTTP_429()
    {
        using var handler = new StatusWorker(HttpStatusCode.TooManyRequests);
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 0, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.too_many_watches", result.Error.Code);
    }

    [Fact]
    public async Task A_409_from_the_worker_is_mapped_to_pets_busy_and_HTTP_409()
    {
        using var handler = new StatusWorker(HttpStatusCode.Conflict);
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Design a habit tracker"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.busy", result.Error.Code);
    }

    [Fact]
    public async Task A_worker_failure_is_logged_with_its_operation_and_status_but_no_content()
    {
        using var handler = new StatusWorker(HttpStatusCode.ServiceUnavailable);
        using var http = new HttpClient(handler);
        var logger = new CapturingLogger<PetWorkerClient>();
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), logger);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "private message text"), Cancellation);

        Assert.True(result.IsFailure);
        var message = Assert.Single(logger.Messages);
        Assert.Contains("send", message, StringComparison.Ordinal);
        Assert.Contains("HTTP 503", message, StringComparison.Ordinal);
        Assert.Contains("pets.unavailable", message, StringComparison.Ordinal);
        Assert.DoesNotContain("private message text", message, StringComparison.Ordinal);
        Assert.DoesNotContain(WorkspaceGuid.ToString(), message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_worker_response_over_the_four_mebibyte_cap_is_refused_as_pets_unavailable()
    {
        using var handler = new OversizedWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions());

        var result = await gateway.ExecuteAsync(new("status"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.unavailable", result.Error.Code);
    }

    private static IConfiguration Configuration() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["Nix:Pets:WorkerUrl"] = "http://worker:8301",
        ["Nix:InternalSecret"] = "test-secret",
    }).Build();

    private static ScopedNixSessionContextAccessor Session()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        return session;
    }

    private static NixDispatcher Dispatcher()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IQueryHandler<GetWorkspace, WorkspaceSnapshot?>>(new FakeGetWorkspaceHandler());
        services.AddSingleton<IQueryHandler<GetPetSettings, PetSettingsResponse>>(new FakeGetPetSettingsHandler());
        return new NixDispatcher(services.BuildServiceProvider());
    }

    private sealed class FakeGetWorkspaceHandler : IQueryHandler<GetWorkspace, WorkspaceSnapshot?>
    {
        public ValueTask<WorkspaceSnapshot?> HandleAsync(GetWorkspace query, CancellationToken cancellationToken) =>
            ValueTask.FromResult<WorkspaceSnapshot?>(new(query.WorkspaceId, "Workspace", 30, 0, DateTimeOffset.UtcNow,
                null, false, false, false, false, null, "active", null));
    }

    private sealed class FakeGetPetSettingsHandler : IQueryHandler<GetPetSettings, PetSettingsResponse>
    {
        public ValueTask<PetSettingsResponse> HandleAsync(GetPetSettings query, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new PetSettingsResponse(0, new(true, PetGuid, "system", false,
                [new(PetGuid, "Nix", "owl", "playful", "balanced", "Explain clearly.")])));
    }

    private sealed class StubPermissions : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    /// <summary>Denies workspace read: proves watch is refused through the same permission
    /// check "read" goes through, exactly like a foreign workspace or a caller with no access.</summary>
    private sealed class DenyReadPermissions : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class RecordingWorker : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public string Body { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,\"messages\":[]}", System.Text.Encoding.UTF8, "application/json"),
            };
        }
    }

    /// <summary>Answers with a fixed non-success status and no body, standing in for the worker's
    /// own backpressure (429) and single-flight contention (409) refusals.</summary>
    private sealed class StatusWorker(HttpStatusCode statusCode) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(statusCode));
    }

    /// <summary>Answers 200 with a body one byte over <see cref="PetWorkerClient"/>'s four
    /// mebibyte cap, proving the cap is enforced while streaming rather than after buffering.</summary>
    private sealed class OversizedWorker : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const int capBytes = 4 * 1024 * 1024;
            var padding = new string('a', capBytes + 1);
            var body = $"{{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"{padding}\",\"canConnect\":false,\"messages\":[]}}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }
}
