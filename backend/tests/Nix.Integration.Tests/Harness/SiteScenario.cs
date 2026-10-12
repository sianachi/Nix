using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A persistence host configured for sites, plus the few moves every sites suite makes: run a
/// command as a person, create an item, and seed the people the manager rule is judged against.
/// </summary>
/// <remarks>
/// Alpha's seeded principal is a tenant administrator, which makes them an owner of every
/// workspace: the manager. The editor, the viewer and the outsider are plain members (or not
/// members at all), so the same request can be sent as someone who must be refused.
/// </remarks>
internal sealed class SiteScenario : IAsyncDisposable
{
    /// <summary>The sites domain the scenario configures.</summary>
    public const string Domain = "sites.example.net";

    /// <summary>An editor of Alpha's workspace.</summary>
    public static readonly Guid Editor = new("5e1e1e1e-1111-4111-8111-5e1e1e1e1e1e");

    /// <summary>A viewer of Alpha's workspace.</summary>
    public static readonly Guid Viewer = new("5e2e2e2e-1111-4111-8111-5e2e2e2e2e2e");

    /// <summary>A person in Alpha's tenant who is not a member of its workspace.</summary>
    public static readonly Guid Outsider = new("5e3e3e3e-1111-4111-8111-5e3e3e3e3e3e");

    private readonly NixPersistenceHost _host;

    private SiteScenario(NixPersistenceHost host) => _host = host;

    /// <summary>Gets the manager: Alpha's seeded tenant administrator.</summary>
    public static NixSessionContext Manager => TestTenants.AlphaContext;

    /// <summary>Gets the editor's session.</summary>
    public static NixSessionContext EditorContext => TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Editor);

    /// <summary>Gets the viewer's session.</summary>
    public static NixSessionContext ViewerContext => TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Viewer);

    /// <summary>Gets the outsider's session.</summary>
    public static NixSessionContext OutsiderContext => TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Outsider);

    /// <summary>Gets the settings that enable sites against a fake object store.</summary>
    public static Dictionary<string, string?> Settings => new()
    {
        ["Nix:Sites:Domain"] = Domain,
        ["Nix:Sites:Bucket"] = "nix-sites",
        ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
        ["Nix:ObjectStorage:Region"] = "us-east-1",
        ["Nix:ObjectStorage:Bucket"] = "nix-objects",
        ["Nix:ObjectStorage:AccessKey"] = "sites-access",
        ["Nix:ObjectStorage:SecretKey"] = "sites-secret",
    };

    /// <summary>Builds a scenario over the fixture's database and seeds the people.</summary>
    public static async Task<SiteScenario> CreateAsync(NixPostgresFixture fixture, Dictionary<string, string?>? overrides = null)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        await SeedPeopleAsync(fixture);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(Settings).AddInMemoryCollection(overrides ?? []).Build();
#pragma warning disable CA2000 // Justification: the scenario owns the host and disposes it.
        return new SiteScenario(NixPersistenceHost.Create(fixture.ApplicationConnectionString, configuration: configuration));
#pragma warning restore CA2000
    }

    /// <summary>Seeds the editor, the viewer and the outsider into Alpha's tenant.</summary>
    public static async Task SeedPeopleAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var (id, name, role) in new[] { (Editor, "editor", "editor"), (Viewer, "viewer", "viewer"), (Outsider, "outsider", null) })
            {
                await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    INSERT INTO principal
                        (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                         email, email_normalized, email_verified, status, deprovisioned_at)
                    VALUES ('{id}', '{TestTenants.Alpha}', 'https://issuer.alpha.test', 'sites-{name}', 'user',
                            'sites {name}', 'sites-{name}@example.test', 'sites-{name}@example.test', true,
                            'active', NULL);
                    """);
                if (role is not null)
                {
                    await RawSql.ExecuteAsync(
                        connection,
                        transaction: null,
                        $"""
                        INSERT INTO workspace_member
                            (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                        VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{id}', '{TestTenants.Alpha}', '{role}',
                                '{TestTenants.AlphaPrincipal}', now());
                        """);
                }
            }
        }
    }

    /// <summary>Runs <paramref name="work"/> as <paramref name="who"/> and commits it.</summary>
    public async Task<T> RunAsync<T>(NixSessionContext who, Func<NixUnitOfWork, Task<T>> work)
    {
        ArgumentNullException.ThrowIfNull(work);
        var unit = await _host.BeginUnitOfWorkAsync(who, TestContext.Current.CancellationToken);
        await using (unit.ConfigureAwait(false))
        {
            var result = await work(unit);
            await unit.CommitAsync(TestContext.Current.CancellationToken);
            return result;
        }
    }

    /// <summary>Sends a command as <paramref name="who"/>, committing only when it succeeds.</summary>
    public async Task<Result<TValue>> SendAsync<TCommand, TValue>(NixSessionContext who, TCommand command)
        where TCommand : ICommand<TValue>
    {
        var unit = await _host.BeginUnitOfWorkAsync(who, TestContext.Current.CancellationToken);
        await using (unit.ConfigureAwait(false))
        {
            var result = await unit.Resolve<NixDispatcher>().SendAsync<TCommand, TValue>(command, TestContext.Current.CancellationToken);
            if (result.IsSuccess)
            {
                await unit.CommitAsync(TestContext.Current.CancellationToken);
            }

            return result;
        }
    }

    /// <summary>Asks a query as <paramref name="who"/>.</summary>
    public async Task<TResult> QueryAsync<TQuery, TResult>(NixSessionContext who, TQuery query)
        where TQuery : IQuery<TResult>
    {
        var unit = await _host.BeginUnitOfWorkAsync(who, TestContext.Current.CancellationToken);
        await using (unit.ConfigureAwait(false))
        {
            return await unit.Resolve<NixDispatcher>().QueryAsync<TQuery, TResult>(query, TestContext.Current.CancellationToken);
        }
    }

    /// <summary>Creates an item under <paramref name="parent"/> in Alpha's workspace and returns it.</summary>
    public async Task<ItemId> CreateItemAsync(string title, ItemId parent, string type = "note", JsonObject? properties = null)
    {
        var created = await SendAsync<CreateItem, Item>(
            Manager,
            new CreateItem(WorkspaceId.From(TestTenants.AlphaWorkspace), type, title, parent, properties));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        return created.Value.Id;
    }

    /// <summary>Creates a completed file item of the given media type, at the top level or under <paramref name="parent"/>, and returns its item.</summary>
    public async Task<ItemId> CreateFileAsync(string name, string mediaType, string sha256, long byteLength = 12, ItemId? parent = null)
    {
        return await RunAsync(Manager, async unit =>
        {
            var files = unit.Resolve<IFileStore>();
            var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(WorkspaceId.From(TestTenants.AlphaWorkspace), parent, null, name, mediaType, byteLength, "site-" + name),
                TestContext.Current.CancellationToken));
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), TestContext.Current.CancellationToken));
            var file = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(FileUploadId.From(upload.Id), mediaType, byteLength, sha256, Previewable: true, PixelWidth: 4, PixelHeight: 2),
                TestContext.Current.CancellationToken));
            return ItemId.From(file.ItemId);
        });
    }

    /// <summary>Resolves a service in a unit of work for <paramref name="who"/> without committing.</summary>
    public async Task<T> ReadAsync<T>(NixSessionContext who, Func<NixUnitOfWork, Task<T>> read)
    {
        ArgumentNullException.ThrowIfNull(read);
        var unit = await _host.BeginUnitOfWorkAsync(who, TestContext.Current.CancellationToken);
        await using (unit.ConfigureAwait(false))
        {
            return await read(unit);
        }
    }

    /// <summary>Gets a service scope that is not bound to any tenant, for the cross-tenant planner.</summary>
    public AsyncServiceScope UnscopedScope() => _host.CreateUnscopedScope();

    /// <inheritdoc />
    public ValueTask DisposeAsync() => _host.DisposeAsync();
}
