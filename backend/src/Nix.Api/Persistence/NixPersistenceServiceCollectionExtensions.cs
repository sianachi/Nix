using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Views;
using Nix.Features.Bookmarks;
using Nix.Features.Calendar;
using Nix.Features.Canvas;
using Nix.Features.Charts;
using Nix.Features.CurrentUser;
using Nix.Features.Graph;
using Nix.Features.Identity;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Query;
using Nix.Features.Recurrence;
using Nix.Features.Search;
using Nix.Features.Templates;
using Nix.Features.Tokens;
using Nix.Features.Views;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence.Authorization;
using Nix.Persistence.Bookmarks;
using Nix.Persistence.Calendar;
using Nix.Persistence.Content;
using Nix.Persistence.Graph;
using Nix.Persistence.Identity;
using Nix.Persistence.Items;
using Nix.Persistence.Links;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Plugins;
using Nix.Persistence.Properties;
using Nix.Persistence.Query;
using Nix.Persistence.Recurrence;
using Nix.Persistence.Rls;
using Nix.Persistence.Search;
using Nix.Persistence.Sql;
using Nix.Persistence.Templates;
using Nix.Persistence.Tokens;
using Nix.Persistence.Workspaces;
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

        // The scope ceiling of a token-authenticated request, set by the unit-of-work middleware
        // and read by the one handler that reports a write capability to the collaboration
        // service. Interactive sessions never set it and it stays permissive.
        services.AddScoped<AccessTokenSessionContext>();

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
        services.AddSingleton<Nix.Persistence.Workers.WorkerDispatchStore>();
        services.AddSingleton<IWorkerDispatchStore>(provider => provider.GetRequiredService<Nix.Persistence.Workers.WorkerDispatchStore>());
        services.AddScoped<IWorkerExecutionFence, Nix.Persistence.Workers.WorkerExecutionFence>();
        services.AddSingleton<Nix.Persistence.Workers.SearchIndexDispatchStore>();
        services.AddSingleton<PluginDispatchStore>();
        services.AddScoped<PluginInstallationStore>();
        services.AddScoped<Nix.Persistence.Workers.WorkerStore>();
        services.AddScoped<IWorkerJobStore>(provider => provider.GetRequiredService<Nix.Persistence.Workers.WorkerStore>());
        services.AddScoped<IWorkerOutboxStore>(provider => provider.GetRequiredService<Nix.Persistence.Workers.WorkerStore>());
        services.AddScoped<IFileStore, Nix.Persistence.Files.FileStore>();
        services.AddScoped<IDocumentImportStore, Nix.Persistence.Importing.DocumentImportStore>();
        services.AddSingleton<AbandonedObjectOperationStore>();
        services.AddSingleton<AbandonedObjectReaper>();
        services.AddSingleton<Microsoft.Extensions.Hosting.IHostedService>(
            provider => provider.GetRequiredService<AbandonedObjectReaper>());

        // Scoped, like everything else here: a store reads the scope's tenant and shares the
        // context's transaction, so it belongs to one unit of work and one tenant.
        services.AddScoped<IItemTree, ItemTree>();
        services.AddScoped<IIdentityDirectory, IdentityDirectory>();
        services.AddScoped<IBrowserSessions, BrowserSessionStore>();
        services.AddScoped<PersonalWorkspaceProvisioner>();
        services.AddScoped<IPersonalWorkspaceProvisioner>(provider => provider.GetRequiredService<PersonalWorkspaceProvisioner>());
        services.AddScoped<IPrincipalDirectory, PrincipalDirectory>();

        // Scoped because it memoises resolutions for the unit of work: a listing that renders
        // twenty items under one parent resolves one schema rather than twenty.
        services.AddScoped<ISchemaResolver, SchemaResolver>();

        // Scoped like the stores, and stateless: it holds no answers between calls because a fold
        // is over rows this same unit of work may be changing - the argument SchemaResolver makes
        // for not memoising, arriving at the same conclusion from the other direction.
        services.AddScoped<IChildAggregates, ChildAggregateReader>();

        // The one authorization code path. Scoped like the stores, and for a stronger reason: it
        // memoises answers for the lifetime of the unit of work, and a unit of work is one request
        // acting as one principal in one tenant.
        services.AddScoped<IPermissionResolver, WorkspaceMembershipResolver>();

        // The two readers over the derived tables. Scoped like the stores: both borrow the unit of
        // work's connection so their statements run inside the transaction that published the RLS
        // session context.
        services.AddScoped<ItemSearch>();
        services.AddScoped<IItemSearch>(provider => provider.GetRequiredService<ItemSearch>());
        services.AddScoped<IItemLinks, ItemLinks>();
        services.AddScoped<ICanvasLibraryStore, CanvasLibraryStore>();
        services.AddScoped<IWorkspaceGraph, WorkspaceGraphReader>();
        services.AddScoped<IWorkspaceCalendar, WorkspaceCalendarReader>();
        services.AddScoped<IRecurrenceCandidates, RecurrenceCandidateReader>();
        services.AddScoped<IRecurrenceStore, RecurrenceStore>();
        services.AddScoped<IItemQuery, ItemQueryReader>();
        services.AddScoped<IBookmarkShelf, BookmarkShelfStore>();
        services.AddScoped<IPublicFormStore, PublicFormStore>();
        services.AddScoped<IPersonalAccessTokens, PersonalAccessTokenStore>();
        services.AddScoped<WorkspaceAdministrationStore>();
        services.AddSingleton<TemplateDefinitionValidator>();
        services.AddSingleton<TemplateMergePlanner>();
        services.AddScoped<TemplateStore>();
        services.AddScoped<ITemplateCatalogStore>(provider => provider.GetRequiredService<TemplateStore>());
        services.AddScoped<ITemplateDraftStore>(provider => provider.GetRequiredService<TemplateStore>());
        services.AddScoped<ITemplateStagingStore>(provider => provider.GetRequiredService<TemplateStore>());
        services.AddScoped<ITemplateApplicationStore>(provider => provider.GetRequiredService<TemplateStore>());
        services.AddScoped<ITemplateManagedStore>(provider => provider.GetRequiredService<TemplateStore>());
        services.AddScoped<ITemplateAuthorizationStore>(provider => provider.GetRequiredService<TemplateStore>());

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
        services.AddScoped<ICommandHandler<ProvisionPersonalWorkspace, AuthenticatedPrincipal>, ProvisionPersonalWorkspaceHandler>();
        services.AddScoped<ICommandHandler<CompleteBrowserSignIn, CompletedBrowserSignIn>, CompleteBrowserSignInHandler>();
        services.AddScoped<ICommandHandler<CreateStructuredItem, Item>, CreateStructuredItemHandler>();
        services.AddScoped<ICommandHandler<AppendViewSetup, Item>, AppendViewSetupHandler>();
        services.AddScoped<ICommandHandler<ReplaceViewSetup, Item>, ReplaceViewSetupHandler>();
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
        services.AddScoped<IQueryHandler<ItemRollups, IReadOnlyDictionary<ItemId, JsonObject>>, ItemRollupsHandler>();
        services.AddScoped<IQueryHandler<RunItemChart, Result<ItemChart>>, RunItemChartHandler>();

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
        services.AddScoped<ICommandHandler<SetItemRecurrence, Item>, SetItemRecurrenceHandler>();
        services.AddScoped<ICommandHandler<CompleteRecurrenceOccurrence, Item>, CompleteRecurrenceOccurrenceHandler>();
        services.AddScoped<IQueryHandler<RunItemQuery, Result<ItemQueryResults>>, RunItemQueryHandler>();
        services.AddScoped<IQueryHandler<GetShelf, Result<ShelfResults>>, GetShelfHandler>();
        services.AddScoped<ICommandHandler<KeepItem, bool>, KeepItemHandler>();
        services.AddScoped<ICommandHandler<ReleaseItem, bool>, ReleaseItemHandler>();

        services.AddScoped<ICommandHandler<CreateAccessToken, IssuedAccessToken>, CreateAccessTokenHandler>();
        services.AddScoped<IQueryHandler<ListAccessTokens, Result<IReadOnlyList<PersonalAccessToken>>>, ListAccessTokensHandler>();
        services.AddScoped<ICommandHandler<RevokeAccessToken, bool>, RevokeAccessTokenHandler>();

        services.AddScoped<IQueryHandler<ListWorkspaces, IReadOnlyList<WorkspaceSnapshot>>, ListWorkspacesHandler>();
        services.AddScoped<IQueryHandler<GetWorkspace, WorkspaceSnapshot?>, GetWorkspaceHandler>();
        services.AddScoped<ICommandHandler<CreateWorkspace, WorkspaceSnapshot>, CreateWorkspaceHandler>();
        services.AddScoped<ICommandHandler<RenameWorkspace, WorkspaceSnapshot>, RenameWorkspaceHandler>();
        services.AddScoped<IQueryHandler<ListWorkspaceMembers, IReadOnlyList<WorkspaceMemberSnapshot>>, ListWorkspaceMembersHandler>();
        services.AddScoped<IQueryHandler<ListWorkspaceInvitees, IReadOnlyList<WorkspaceInviteeSnapshot>>, ListWorkspaceInviteesHandler>();
        services.AddScoped<IQueryHandler<ListWorkspaceInvitations, IReadOnlyList<WorkspaceInvitationSnapshot>>, ListWorkspaceInvitationsHandler>();
        services.AddScoped<ICommandHandler<InviteWorkspaceMember, WorkspaceInvitationSnapshot>, InviteWorkspaceMemberHandler>();
        services.AddScoped<ICommandHandler<RevokeWorkspaceInvitation, bool>, RevokeWorkspaceInvitationHandler>();
        services.AddScoped<ICommandHandler<AcceptWorkspaceInvitation, bool>, AcceptWorkspaceInvitationHandler>();
        services.AddScoped<ICommandHandler<DeclineWorkspaceInvitation, bool>, DeclineWorkspaceInvitationHandler>();
        services.AddScoped<
            ICommandHandler<ChangeWorkspaceMemberRole, WorkspaceMemberSnapshot>,
            ChangeWorkspaceMemberRoleHandler>();
        services.AddScoped<ICommandHandler<RemoveWorkspaceMember, bool>, RemoveWorkspaceMemberHandler>();
        services.AddScoped<ICommandHandler<LeaveWorkspace, bool>, LeaveWorkspaceHandler>();
        services.AddScoped<ICommandHandler<RecoverWorkspace, WorkspaceSnapshot>, RecoverWorkspaceHandler>();
        services.AddScoped<ICommandHandler<OpenDailyNote, Guid>, OpenDailyNoteHandler>();

        services.AddScoped<IQueryHandler<ListTemplates, Result<TemplateLibrarySnapshot>>, ListTemplatesHandler>();
        services.AddScoped<IQueryHandler<GetTemplate, Result<TemplateDetailSnapshot>>, GetTemplateHandler>();
        services.AddScoped<IQueryHandler<GetTemplateItem, Result<TemplateItemSnapshot>>, GetTemplateItemHandler>();
        services.AddScoped<ICommandHandler<DeleteTemplate, bool>, DeleteTemplateHandler>();
        services.AddScoped<IQueryHandler<PreflightTemplateApplication, Result<TemplatePreflight>>, PreflightTemplateApplicationHandler>();
        services.AddScoped<IQueryHandler<ExportTemplate, Result<TemplateExportSnapshot>>, ExportTemplateHandler>();
        services.AddScoped<ICommandHandler<BeginTemplateDraft, TemplateDraftPlan>, BeginTemplateDraftHandler>();
        services.AddScoped<IQueryHandler<GetTemplateDraft, Result<TemplateDraftPlan>>, GetTemplateDraftHandler>();
        services.AddScoped<ICommandHandler<UpdateTemplateDraft, TemplateDraftPlan>, UpdateTemplateDraftHandler>();
        services.AddScoped<ICommandHandler<UpdateTemplateDraftItem, TemplateItemSnapshot>, UpdateTemplateDraftItemHandler>();
        services.AddScoped<IQueryHandler<AuthorizeTemplateDraftItem, Result<TemplateItemAuthorization>>, AuthorizeTemplateDraftItemHandler>();
        services.AddScoped<ICommandHandler<SaveTemplateDraft, TemplateId>, SaveTemplateDraftHandler>();
        services.AddScoped<ICommandHandler<DiscardTemplateDraft, bool>, DiscardTemplateDraftHandler>();
        services.AddScoped<ICommandHandler<BeginTemplateCapture, TemplateCapturePlan>, BeginTemplateCaptureHandler>();
        services.AddScoped<ICommandHandler<BeginTemplateImport, TemplateImportPlan>, BeginTemplateImportHandler>();
        services.AddScoped<ICommandHandler<FinalizeTemplateOperation, TemplateId>, FinalizeTemplateOperationHandler>();
        services.AddScoped<ICommandHandler<AbortTemplateOperation, bool>, AbortTemplateOperationHandler>();
        services.AddScoped<ICommandHandler<BeginTemplateApplication, TemplateApplicationPlan>, BeginTemplateApplicationHandler>();
        services.AddScoped<ICommandHandler<FinalizeTemplateApplication, ItemId>, FinalizeTemplateApplicationHandler>();
        services.AddScoped<ICommandHandler<AbortTemplateApplication, bool>, AbortTemplateApplicationHandler>();
        services.AddScoped<ICommandHandler<FinalizeManagedTemplates, ManagedTemplateBatchResult>, FinalizeManagedTemplatesHandler>();
        services.AddScoped<ICommandHandler<SweepExpiredTemplateStages, TemplateStageSweepResult>, SweepExpiredTemplateStagesHandler>();
        services.AddScoped<IQueryHandler<AuthorizeTemplateImport, Result<TemplateWorkspaceAuthorization>>, AuthorizeTemplateImportHandler>();
        services.AddScoped<IQueryHandler<AuthorizeTemplateOperationItem, Result<TemplateOperationAuthorization>>, AuthorizeTemplateOperationItemHandler>();
        services.AddScoped<IQueryHandler<AuthorizeTemplateOperationWrites, Result<TemplateOperationWriteAuthorization>>, AuthorizeTemplateOperationWritesHandler>();
        services.AddScoped<IQueryHandler<AuthorizeTemplateItem, Result<TemplateItemAuthorization>>, AuthorizeTemplateItemHandler>();

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
