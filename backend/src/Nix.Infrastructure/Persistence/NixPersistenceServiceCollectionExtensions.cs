using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Application.Authorization;
using Nix.Application.Identity;
using Nix.Application.Items;
using Nix.Application.Persistence;
using Nix.Application.Properties;
using Nix.Application.Views;
using Nix.Infrastructure.Persistence.Authorization;
using Nix.Infrastructure.Persistence.Identity;
using Nix.Infrastructure.Persistence.Items;
using Nix.Infrastructure.Persistence.Properties;
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

        // Scoped, like everything else here: a store reads the scope's tenant and shares the
        // context's transaction, so it belongs to one unit of work and one tenant.
        services.AddScoped<IItemTree, ItemTree>();
        services.AddScoped<IIdentityDirectory, IdentityDirectory>();
        services.AddScoped<IPrincipalDirectory, PrincipalDirectory>();

        // Scoped because it memoises resolutions for the unit of work: a listing that renders
        // twenty items under one parent resolves one schema rather than twenty.
        services.AddScoped<ISchemaResolver, SchemaResolver>();

        // The one authorization code path. Scoped like the stores, and for a stronger reason: it
        // memoises answers for the lifetime of the unit of work, and a unit of work is one request
        // acting as one principal in one tenant.
        services.AddScoped<IPermissionResolver, WorkspaceMembershipResolver>();

        // The use cases below take a clock, so this registration owes them one. TryAdd rather than
        // Add: a host that wants a controllable clock registers its own first and keeps it, while a
        // host that registers nothing still gets a working graph instead of a resolution failure at
        // the first request that creates something.
        services.TryAddSingleton(TimeProvider.System);

        // Use cases are scoped for the same reason as the stores they call: one unit of work, one
        // tenant. They are concrete types rather than interfaces - there is one implementation of
        // each and no swap planned, so an interface would be indirection tax.
        services.AddScoped<CreateItem>();
        services.AddScoped<GetCurrentPrincipal>();
        services.AddScoped<DeleteItem>();
        services.AddScoped<GetItem>();
        services.AddScoped<ItemsWithChildren>();
        services.AddScoped<ListItems>();
        services.AddScoped<MoveItem>();
        services.AddScoped<RenameItem>();
        services.AddScoped<RestoreItem>();
        services.AddScoped<GetEffectiveSchema>();
        services.AddScoped<SetItemSchema>();
        services.AddScoped<SetItemProperties>();
        services.AddScoped<GetContainerViews>();
        services.AddScoped<SetContainerViews>();

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
