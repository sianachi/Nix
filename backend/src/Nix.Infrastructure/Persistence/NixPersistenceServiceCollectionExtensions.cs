using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Application.Persistence;
using Nix.Infrastructure.Persistence.Rls;
using Nix.Infrastructure.Persistence.Sql;
using Npgsql;

namespace Nix.Infrastructure.Persistence;

/// <summary>
/// Registers the persistence stack: the data source, the context, the row-level security session
/// interceptor, and the hand-written SQL executor.
/// </summary>
public static class NixPersistenceServiceCollectionExtensions
{
    /// <summary>
    /// Roles the application must never connect as.
    /// </summary>
    /// <remarks>
    /// <c>nix_migrator</c> holds <c>BYPASSRLS</c>. An application connected as that role would
    /// read every tenant's rows through policies that are still, technically, present and
    /// correct - so nothing would look wrong until it did. This list is checked at startup
    /// because a connection string is a deployment artefact and deployment artefacts get
    /// copy-pasted.
    /// </remarks>
    public static readonly IReadOnlyList<string> ForbiddenApplicationRoles =
        ["nix_migrator", "postgres"];

    /// <summary>
    /// Registers the persistence stack with default options.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <param name="connectionString">A connection string for the runtime role.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddNixPersistence(this IServiceCollection services, string connectionString) =>
        services.AddNixPersistence(new NixPersistenceOptions { ConnectionString = connectionString });

    /// <summary>
    /// Registers the persistence stack.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <param name="options">Connection and command configuration.</param>
    /// <returns>The service collection, for chaining.</returns>
    /// <remarks>
    /// <para>
    /// What this deliberately does not do is run migrations. Schema changes are a deployment step
    /// executed by <c>Nix.Migrator</c> as <c>nix_migrator</c>; see
    /// <c>Persistence.Migrations.NixMigrationRunner</c> for why startup is the wrong place.
    /// </para>
    /// <para>
    /// Lifetimes: the data source is a singleton because it owns the connection pool; the context,
    /// the session-context accessor, and the SQL executor are scoped, because a scope is a unit of
    /// work and a unit of work belongs to exactly one tenant. The context is intentionally not
    /// pooled - <c>AddDbContextPool</c> would outlive the scope that carries the tenant.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentException">
    /// The connection string is empty, unparseable, or authenticates as a role the application
    /// must never use.
    /// </exception>
    public static IServiceCollection AddNixPersistence(
        this IServiceCollection services,
        NixPersistenceOptions options)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(options);

        var connectionString = AssertRuntimeConnectionString(options.ConnectionString);

        services.AddSingleton(_ => new NpgsqlDataSourceBuilder(connectionString).Build());

        // One instance, two registrations: the writer type for whoever establishes the scope's
        // tenant, the read-only port for everyone who consumes it.
        services.AddScoped<ScopedNixSessionContextAccessor>();
        services.AddScoped<INixSessionContextAccessor>(
            static provider => provider.GetRequiredService<ScopedNixSessionContextAccessor>());

        services.AddScoped<RlsSessionContextInterceptor>();
        services.AddSingleton<RlsTransactionGuardInterceptor>();

        var commandTimeoutSeconds = (int)options.CommandTimeout.TotalSeconds;
        services.AddDbContext<NixDbContext>((provider, builder) =>
        {
            builder
                .UseNpgsql(
                    provider.GetRequiredService<NpgsqlDataSource>(),
                    npgsql =>
                    {
                        npgsql.CommandTimeout(commandTimeoutSeconds);

                        // No EnableRetryOnFailure. The execution strategy it installs refuses to
                        // work with user-initiated transactions, and every unit of work here is
                        // one: the session context only exists inside a transaction. Retries
                        // belong at the use-case level, where the work is known to be idempotent.
                    })
                .AddInterceptors(
                    provider.GetRequiredService<RlsSessionContextInterceptor>(),
                    provider.GetRequiredService<RlsTransactionGuardInterceptor>());
        });

        services.AddScoped<NixSqlExecutor>();

        return services;
    }

    private static string AssertRuntimeConnectionString(string connectionString)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionString);

        NpgsqlConnectionStringBuilder parsed;
        try
        {
            parsed = new NpgsqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException exception)
        {
            throw new ArgumentException(
                "The persistence connection string could not be parsed.",
                nameof(connectionString),
                exception);
        }

        var username = parsed.Username;
        if (username is null)
        {
            return connectionString;
        }

        foreach (var forbidden in ForbiddenApplicationRoles)
        {
            if (!string.Equals(username, forbidden, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            throw new ArgumentException(
                $"Refusing to start: the application is configured to connect as '{username}'. " +
                "That role can bypass row-level security, which is the tenant isolation " +
                "boundary. Use the runtime role (nix_app).",
                nameof(connectionString));
        }

        return connectionString;
    }
}
