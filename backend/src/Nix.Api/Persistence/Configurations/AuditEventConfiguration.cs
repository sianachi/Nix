using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Audit;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="AuditEvent"/> to <c>audit_event</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>No foreign key on <c>actor_id</c>.</b> Audit rows outlive the principals they name - that is
/// the point of an audit trail - and a reference would make purging a departed employee's record
/// either impossible or a cascade that destroys the evidence of what they did. The identifier is
/// stored as a value, and a reader that wants a name joins optionally and copes with its absence.
/// </para>
/// <para>
/// The table is insert-only by grant, not by convention; the migration narrows the runtime role's
/// privileges on it after creating it.
/// </para>
/// </remarks>
internal sealed class AuditEventConfiguration : IEntityTypeConfiguration<AuditEvent>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<AuditEvent> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.AuditEvent);

        builder.HasKey(auditEvent => auditEvent.Id);
        builder.Property(auditEvent => auditEvent.Id).HasColumnName("event_id");
        builder.Property(auditEvent => auditEvent.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(auditEvent => auditEvent.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(auditEvent => auditEvent.ActorId).HasColumnName("actor_id");
        builder.Property(auditEvent => auditEvent.OnBehalfOf).HasColumnName("on_behalf_of");
        builder.Property(auditEvent => auditEvent.Action).HasColumnName("action").IsRequired();
        builder.Property(auditEvent => auditEvent.SubjectId).HasColumnName("subject_id");
        builder.Property(auditEvent => auditEvent.SubjectType).HasColumnName("subject_type").IsRequired();

        builder.Property(auditEvent => auditEvent.Before).HasColumnName("before").HasColumnType("jsonb");
        builder.Property(auditEvent => auditEvent.After).HasColumnName("after").HasColumnType("jsonb");

        builder.Property(auditEvent => auditEvent.ActorIp).HasColumnName("actor_ip").HasColumnType("inet");
        builder.Property(auditEvent => auditEvent.OccurredAt).HasColumnName("occurred_at");

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(auditEvent => auditEvent.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        // Audit is read as a time-ordered feed within a tenant, newest first.
        //
        // Ascending, deliberately. A descending index over a monotonic timestamp sorts every new
        // row to the leftmost leaf of its tenant's range, and Postgres has a rightmost-page fast
        // path with no leftmost equivalent - so every insert splits a leaf 50/50. Measured over
        // 300,000 rows: 21 MB and 99.9% fragmentation descending, against 12 MB and none
        // ascending, for a 12% difference in WAL volume. The feed query is served identically by
        // an Index Scan Backward, at 4 buffers.
        builder.HasIndex(auditEvent => new { auditEvent.TenantId, auditEvent.OccurredAt });

        // "Everything that happened to this thing" is the second question an investigation asks,
        // and it deliberately has no index yet: the runtime role holds INSERT and nothing else on
        // this table, so no such query can run until the audit export goal builds a read path.
        // Maintaining it now measured at +93% WAL per audit row for a reader that does not exist.
        // It belongs in that goal's migration, next to the reader that justifies it.
    }
}
