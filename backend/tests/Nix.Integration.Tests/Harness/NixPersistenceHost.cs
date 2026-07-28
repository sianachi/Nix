using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Persistence;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A composition root built the way the application builds one - through
/// <see cref="NixPersistenceServiceCollectionExtensions.AddNixPersistence(IServiceCollection, string)"/>
/// - so the tests exercise the registration the host will use rather than a hand-wired
/// approximation of it.
/// </summary>
/// <remarks>
/// Each host owns its own <c>NpgsqlDataSource</c>, and therefore its own connection pool. That is
/// what lets the pool-scoping proof ask for a pool of exactly one physical connection without
/// disturbing every other test in the suite.
/// </remarks>
internal sealed class NixPersistenceHost : IAsyncDisposable
{
    private readonly ServiceProvider _services;

    private NixPersistenceHost(ServiceProvider services) => _services = services;

    /// <summary>
    /// Builds a host over <paramref name="connectionString"/>.
    /// </summary>
    /// <param name="connectionString">A connection string for the runtime role.</param>
    /// <returns>The host.</returns>
    public static NixPersistenceHost Create(string connectionString)
    {
        var services = new ServiceCollection();
        services.AddNixPersistence(connectionString);
        return new NixPersistenceHost(services.BuildServiceProvider(validateScopes: true));
    }

    /// <summary>
    /// Opens a scope, establishes <paramref name="context"/> as its tenant, and begins a
    /// transaction.
    /// </summary>
    /// <param name="context">The tenant scope for this unit of work.</param>
    /// <param name="cancellationToken">Cancels the begin.</param>
    /// <returns>The started unit of work; the caller disposes it.</returns>
    public Task<NixUnitOfWork> BeginUnitOfWorkAsync(
        NixSessionContext context,
        CancellationToken cancellationToken = default) =>
        NixUnitOfWork.StartAsync(_services.CreateAsyncScope(), context, cancellationToken);

    /// <summary>
    /// Opens a scope without establishing a tenant, for the tests that assert what happens when
    /// nobody did.
    /// </summary>
    /// <returns>The scope; the caller disposes it.</returns>
    public AsyncServiceScope CreateUnscopedScope() => _services.CreateAsyncScope();

    /// <inheritdoc />
    public ValueTask DisposeAsync() => _services.DisposeAsync();
}
