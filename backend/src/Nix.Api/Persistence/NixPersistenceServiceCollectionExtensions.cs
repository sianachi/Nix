using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Views;
using Nix.Features.Bookmarks;
using Nix.Features.Calendar;
using Nix.Features.Canvas;
using Nix.Features.Graph;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Features.Me;
using Nix.Features.Properties;
using Nix.Features.Search;
using Nix.Features.Views;
using Nix.Messaging;
using Nix.Persistence.Authorization;
using Nix.Persistence.Bookmarks;
using Nix.Persistence.Calendar;
using Nix.Persistence.Content;
using Nix.Persistence.Graph;
using Nix.Persistence.Identity;
using Nix.Persistence.Items;
using Nix.Persistence.Links;
using Nix.Persistence.Properties;
using Nix.Persistence.Rls;
using Nix.Persistence.Search;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence;

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

        // The two readers over the derived tables. Scoped like the stores: both borrow the unit of
        // work's connection so their statements run inside the transaction that published the RLS
        // session context.
        services.AddScoped<IItemSearch, ItemSearch>();
        services.AddScoped<IItemLinks, ItemLinks>();
        services.AddScoped<ICanvasLibraryStore, CanvasLibraryStore>();
        services.AddScoped<IWorkspaceGraph, WorkspaceGraphReader>();
        services.AddScoped<IWorkspaceCalendar, WorkspaceCalendarReader>();
        services.AddScoped<IBookmarkShelf, BookmarkShelfStore>();

        // The use cases below take a clock, so this registration owes them one. TryAdd rather than
        // Add: a host that wants a controllable clock registers its own first and keeps it, while a
        // host that registers nothing still gets a working graph instead of a resolution failure at
        // the first request that creates something.
        services.TryAddSingleton(TimeProvider.System);

        // The dispatcher resolves handlers from the scope it is given, so it is scoped like
        // everything else here: one unit of work, one tenant.
        services.AddScoped<NixDispatcher>();

        // Handlers are scoped for the same reason as the stores they call: one unit of work, one
        // tenant.
        //
        // Registered one line at a time, by hand, with no assembly scanning. Scanning would find
        // these by reflection at startup and hide a missing registration until the first request
        // that needed it; written out, the list is greppable, trims cleanly, and the composition
        // test can walk it. The cost is that adding a handler means remembering this file - which
        // is what CompositionRootTests exists to catch.
        services.AddScoped<ICommandHandler<CreateItem, Item>, CreateItemHandler>();
        services.AddScoped<ICommandHandler<DeleteItem, ItemId>, DeleteItemHandler>();
        services.AddScoped<ICommandHandler<RenameItem, Item>, RenameItemHandler>();
        services.AddScoped<ICommandHandler<MoveItem, Item>, MoveItemHandler>();
        services.AddScoped<ICommandHandler<RestoreItem, Item>, RestoreItemHandler>();
        services.AddScoped<IQueryHandler<GetItem, Result<Item>>, GetItemHandler>();
        services.AddScoped<IQueryHandler<ListItems, Result<IReadOnlyList<Item>>>, ListItemsHandler>();
        services.AddScoped<IQueryHandler<ItemsWithChildren, IReadOnlySet<ItemId>>, ItemsWithChildrenHandler>();

        services.AddScoped<IQueryHandler<GetEffectiveSchema, Result<EffectiveSchema>>, GetEffectiveSchemaHandler>();
        services.AddScoped<ICommandHandler<SetItemSchema, PropertySchema>, SetItemSchemaHandler>();
        services.AddScoped<ICommandHandler<SetItemProperties, Item>, SetItemPropertiesHandler>();

        services.AddScoped<IQueryHandler<GetContainerViews, Result<ContainerViewSet>>, GetContainerViewsHandler>();
        services.AddScoped<ICommandHandler<SetContainerViews, ImmutableArray<ViewDefinition>>, SetContainerViewsHandler>();

        services.AddScoped<IQueryHandler<GetCurrentPrincipal, Result<CurrentPrincipal>>, GetCurrentPrincipalHandler>();

        services.AddScoped<IQueryHandler<GetItemAuthorization, Result<ItemAuthorization>>, GetItemAuthorizationHandler>();
        services.AddScoped<ICommandHandler<TouchItem, ItemId>, TouchItemHandler>();

        services.AddScoped<IQueryHandler<SearchItems, Result<SearchResults>>, SearchItemsHandler>();
        services.AddScoped<IQueryHandler<ResolveReferences, Result<ResolvedReferences>>, ResolveReferencesHandler>();
        services.AddScoped<IQueryHandler<GetBacklinks, Result<BacklinkResults>>, GetBacklinksHandler>();

        services.AddScoped<IQueryHandler<GetCanvasLibrary, CanvasLibraryItems>, GetCanvasLibraryHandler>();
        services.AddScoped<ICommandHandler<SaveCanvasLibrary, CanvasLibraryItems>, SaveCanvasLibraryHandler>();

        services.AddScoped<IQueryHandler<GetWorkspaceGraph, Result<WorkspaceGraphResults>>, GetWorkspaceGraphHandler>();
        services.AddScoped<IQueryHandler<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>, GetWorkspaceCalendarHandler>();
        services.AddScoped<IQueryHandler<GetShelf, Result<ShelfResults>>, GetShelfHandler>();
        services.AddScoped<ICommandHandler<KeepItem, bool>, KeepItemHandler>();
        services.AddScoped<ICommandHandler<ReleaseItem, bool>, ReleaseItemHandler>();

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
