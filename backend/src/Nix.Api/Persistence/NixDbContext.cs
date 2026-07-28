using Microsoft.EntityFrameworkCore;
using Nix.Domain.Audit;
using Nix.Domain.Authorization;
using Nix.Domain.Content;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Configurations;
using Nix.Persistence.Conversion;

namespace Nix.Persistence;

/// <summary>
/// The application's EF Core context: envelope CRUD, and the anchor for the migration history.
/// </summary>
/// <remarks>
/// <para>
/// Holds the M0 schema: tenancy and identity, the item tree and its access control entries, and
/// the audit trail. Per ADR-0002 the whole phase arrives in one migration, so the goals that build
/// on this - authentication, the tree, authorization, audit - add code against tables that already
/// exist rather than each carrying schema of its own.
/// </para>
/// <para>
/// Two rules govern what may be added here:
/// </para>
/// <list type="bullet">
///   <item>
///     <description>
///     EF Core global query filters are ergonomics, not security. They are bypassed by
///     <c>IgnoreQueryFilters()</c> and do not apply to raw SQL at all. Row-level security in the
///     database is the tenant boundary; a filter here is a convenience on top of it and must
///     never be the reason a table is considered isolated.
///     </description>
///   </item>
///   <item>
///     <description>
///     Closure maintenance, permission predicates, and search are hand-written SQL, not LINQ.
///     They live under <c>Persistence/Sql/Statements</c> and run through
///     <c>Nix.Persistence.Sql.NixSqlExecutor</c>, which shares this context's
///     connection and transaction and therefore the same <c>SET LOCAL</c> session context.
///     </description>
///   </item>
/// </list>
/// <para>
/// Tracking is off by default: reads are the common case and change tracking on them is pure
/// cost. Update flows opt in per query with <c>AsTracking()</c>.
/// </para>
/// </remarks>
public sealed class NixDbContext : DbContext
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NixDbContext"/> class.
    /// </summary>
    /// <param name="options">Provider and interceptor configuration.</param>
    public NixDbContext(DbContextOptions<NixDbContext> options)
        : base(options)
    {
    }

    /// <summary>Gets the customer organisations.</summary>
    public DbSet<Tenant> Tenants => Set<Tenant>();

    /// <summary>Gets the containers inside a tenant.</summary>
    public DbSet<Workspace> Workspaces => Set<Workspace>();

    /// <summary>Gets the registered OIDC issuers.</summary>
    public DbSet<IdentityProvider> IdentityProviders => Set<IdentityProvider>();

    /// <summary>Gets the provisioned identities.</summary>
    public DbSet<Principal> Principals => Set<Principal>();

    /// <summary>Gets the named sets of principals.</summary>
    public DbSet<PrincipalGroup> PrincipalGroups => Set<PrincipalGroup>();

    /// <summary>Gets the principal-to-group memberships.</summary>
    public DbSet<GroupMembership> GroupMemberships => Set<GroupMembership>();

    /// <summary>Gets the tenant-wide role grants.</summary>
    public DbSet<TenantRoleGrant> TenantRoleGrants => Set<TenantRoleGrant>();

    /// <summary>Gets the workspace-level role grants.</summary>
    public DbSet<WorkspaceMember> WorkspaceMembers => Set<WorkspaceMember>();

    /// <summary>Gets the items.</summary>
    public DbSet<Item> Items => Set<Item>();

    /// <summary>Gets the derived ancestry edges of the item tree.</summary>
    public DbSet<ItemClosureEdge> ItemClosure => Set<ItemClosureEdge>();

    /// <summary>Gets the access control entries.</summary>
    public DbSet<AclEntry> AclEntries => Set<AclEntry>();

    /// <summary>Gets the audit trail.</summary>
    /// <remarks>
    /// Writable through this set and readable only by a role that is not the application's: the
    /// migration revokes everything but <c>INSERT</c> on the table from <c>nix_app</c>. A query
    /// against this set from the API will fail with insufficient privilege, which is the intended
    /// answer until the audit export goal introduces a read path of its own.
    /// </remarks>
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    /// <summary>Gets the document bodies of native items.</summary>
    public DbSet<ContentDoc> ContentDocs => Set<ContentDoc>();

    /// <summary>
    /// Gets the append-only log of conflict-free updates.
    /// </summary>
    /// <remarks>
    /// Readable here and not writable: the runtime role holds SELECT only on the content tables.
    /// Updates are authored by the collaboration service, which is the only thing that can
    /// validate one - validating means applying it, and that needs a CRDT runtime.
    /// </remarks>
    public DbSet<ContentUpdate> ContentUpdates => Set<ContentUpdate>();

    /// <summary>Gets the materialised snapshots. Derived from the log and rebuildable from it.</summary>
    public DbSet<ContentSnapshot> ContentSnapshots => Set<ContentSnapshot>();

    /// <inheritdoc />
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        ArgumentNullException.ThrowIfNull(optionsBuilder);

        base.OnConfiguring(optionsBuilder);
        optionsBuilder.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
    }

    /// <summary>
    /// Registers the conversions that apply to a type wherever it appears, rather than per
    /// property.
    /// </summary>
    /// <param name="configurationBuilder">The convention builder.</param>
    /// <remarks>
    /// Every typed identifier is mapped here, once. The alternative - a <c>HasConversion</c> call
    /// on each identifier property in each configuration - is the same instruction repeated forty
    /// times, and the failure mode of forgetting one is a property EF cannot map at all, which
    /// surfaces as a model error rather than as anything subtle. Registering by type also means a
    /// new identifier is one line here and nothing else.
    /// </remarks>
    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        ArgumentNullException.ThrowIfNull(configurationBuilder);

        base.ConfigureConventions(configurationBuilder);

        configurationBuilder.Properties<TenantId>().HaveConversion<NixIdConverter<TenantId>>();
        configurationBuilder.Properties<WorkspaceId>().HaveConversion<NixIdConverter<WorkspaceId>>();
        configurationBuilder.Properties<PrincipalId>().HaveConversion<NixIdConverter<PrincipalId>>();
        configurationBuilder.Properties<PrincipalGroupId>().HaveConversion<NixIdConverter<PrincipalGroupId>>();
        configurationBuilder.Properties<IdentityProviderId>().HaveConversion<NixIdConverter<IdentityProviderId>>();
        configurationBuilder.Properties<ItemId>().HaveConversion<NixIdConverter<ItemId>>();
        configurationBuilder.Properties<AclEntryId>().HaveConversion<NixIdConverter<AclEntryId>>();
        configurationBuilder.Properties<AuditEventId>().HaveConversion<NixIdConverter<AuditEventId>>();
        configurationBuilder.Properties<ContentDocId>().HaveConversion<NixIdConverter<ContentDocId>>();
    }

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        base.OnModelCreating(modelBuilder);

        // One table's mapping is one file, under Persistence/Configurations, listed here rather
        // than discovered by ApplyConfigurationsFromAssembly. Reflection would save these twelve
        // lines and cost two things worth more: the set of mapped tables would no longer be
        // readable in one place, and every configuration would look unreferenced to the analysers,
        // which is a real signal to lose across a schema this security-sensitive.
        //
        // A forgotten line here does NOT fail loudly on its own - EF would map the entity by
        // convention and the next scaffold would emit a new, unprotected table. What catches it is
        // the integration suite: The_tenant_scoped_table_list_names_every_table_the_database
        // _actually_has compares the live catalogue against NixTables.TenantScoped, so a table
        // that appears without being declared fails there.
        modelBuilder.ApplyConfiguration(new TenantConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceConfiguration());
        modelBuilder.ApplyConfiguration(new IdentityProviderConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalGroupConfiguration());
        modelBuilder.ApplyConfiguration(new GroupMembershipConfiguration());
        modelBuilder.ApplyConfiguration(new TenantRoleGrantConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceMemberConfiguration());
        modelBuilder.ApplyConfiguration(new ItemConfiguration());
        modelBuilder.ApplyConfiguration(new ItemClosureEdgeConfiguration());
        modelBuilder.ApplyConfiguration(new AclEntryConfiguration());
        modelBuilder.ApplyConfiguration(new AuditEventConfiguration());
        modelBuilder.ApplyConfiguration(new ContentDocConfiguration());
        modelBuilder.ApplyConfiguration(new ContentUpdateConfiguration());
        modelBuilder.ApplyConfiguration(new ContentSnapshotConfiguration());
    }
}
