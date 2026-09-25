using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
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
}
