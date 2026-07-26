using Microsoft.EntityFrameworkCore;

namespace Nix.Infrastructure.Persistence;

/// <summary>
/// The application's EF Core context: envelope CRUD, and the anchor for the migration history.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately empty of entities. This goal delivers the persistence mechanism - connection,
/// interceptors, migration execution, test harness - and nothing else. The tenancy goal adds the
/// first tables on top of a mechanism that is already proven, rather than proving both at once.
/// </para>
/// <para>
/// Two rules govern what may be added here later:
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
///     <c>Nix.Infrastructure.Persistence.Sql.NixSqlExecutor</c>, which shares this context's
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

    /// <inheritdoc />
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        ArgumentNullException.ThrowIfNull(optionsBuilder);

        base.OnConfiguring(optionsBuilder);
        optionsBuilder.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
    }

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        base.OnModelCreating(modelBuilder);

        // Entity configuration arrives with the tenancy goal. Apply it from
        // IEntityTypeConfiguration classes in this assembly rather than inline here, so one
        // table's mapping is one file:
        //   modelBuilder.ApplyConfigurationsFromAssembly(typeof(NixDbContext).Assembly);
    }
}
