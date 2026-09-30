using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Configurations;

internal sealed class ScheduledTriggerConfiguration : IEntityTypeConfiguration<ScheduledTrigger>
{
    public void Configure(EntityTypeBuilder<ScheduledTrigger> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.ScheduledTrigger, table => table.HasCheckConstraint(
            "scheduled_trigger_bounded",
            "kind IN ('reminder', 'automation', 'system')"
                + " AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled')"
                + " AND attempts >= 0 AND char_length(dedupe_key) <= 200"
                + " AND (lease_owner IS NULL OR char_length(lease_owner) <= 128)"
                + " AND char_length(source) <= 64 AND source ~ '^[a-z0-9._-]+$'"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Kind)
            .HasColumnName("kind")
            .HasMaxLength(16)
            .HasConversion(kind => TriggerStorage.ToText(kind), text => TriggerStorage.KindFromText(text))
            .IsRequired();
        builder.Property(row => row.Source).HasColumnName("source").HasMaxLength(64).IsRequired();
        builder.Property(row => row.SourceItemId).HasColumnName("source_item_id");
        builder.Property(row => row.RuleId).HasColumnName("rule_id");
        builder.Property(row => row.FireAt).HasColumnName("fire_at");
        builder.Property(row => row.DedupeKey).HasColumnName("dedupe_key").HasMaxLength(200).IsRequired();
        builder.Property(row => row.Status)
            .HasColumnName("status")
            .HasMaxLength(16)
            .HasConversion(status => TriggerStorage.ToText(status), text => TriggerStorage.StatusFromText(text))
            .IsRequired();
        builder.Property(row => row.LeaseOwner).HasColumnName("lease_owner").HasMaxLength(128);
        builder.Property(row => row.LeaseUntil).HasColumnName("lease_until");
        builder.Property(row => row.Attempts).HasColumnName("attempts");
        builder.Property(row => row.Detail).HasColumnName("detail").HasColumnType("jsonb");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })

            // A trigger is derived state kept on the rule owner's behalf, not a reference to them:
            // when they are purged, their pending triggers stop making sense to fire.
            .OnDelete(DeleteBehavior.Cascade);

        // Unique per recipient, so replanning the same source rule for the same principal upserts
        // the row this key already names instead of creating a duplicate - the planner's own
        // idempotency, mirroring the notification table's dedupe key.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.DedupeKey })
            .IsUnique()
            .HasDatabaseName("IX_scheduled_trigger_tenant_id_principal_id_dedupe_key");

        // Serves the dispatcher's due-lease query: pending rows ordered by when they are due.
        builder.HasIndex(row => new { row.Status, row.FireAt })
            .HasDatabaseName("IX_scheduled_trigger_status_fire_at");

        // Serves the planner's per-source reconcile: which pending triggers a source already owns
        // for a given recipient, so CancelStaleAsync's source-scoped cancel (one source's replan
        // must never touch a different source's rows sharing the same kind) stays an index scan.
        // Named explicitly and kept under Postgres's 63-byte identifier limit: the column-list
        // form of the name this index's role would suggest
        // ("IX_scheduled_trigger_tenant_id_principal_id_kind_source_status_fire_at") is 70
        // characters and gets silently truncated at creation, which then disagrees with the
        // model snapshot and any future lookup by name.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Kind, row.Source, row.Status, row.FireAt })
            .HasDatabaseName("IX_scheduled_trigger_recipient_kind_source_status_fire_at");

        // Serves nix_purge_finished_triggers, which scans finished rows in order by how long ago
        // they finished (ADR-0051 Amendment 2's retention indexes owed to lane B1). Status is not
        // part of the key: the partial predicate already selects exactly the rows that matter, so
        // leading with it would only make the index less selective for the ORDER BY UpdatedAt the
        // purge actually asks for - measured on a realistic corpus as the difference between an
        // ordered index scan and a sequential scan with an on-disk sort. Named explicitly, not
        // because it would otherwise collide with IX_scheduled_trigger_status_fire_at above (EF
        // merges only truly identical column lists, and this one is not), but because every index
        // in this file is named explicitly on principle.
        builder.HasIndex(row => row.UpdatedAt)
            .HasFilter("status IN ('fired', 'skipped', 'cancelled')")
            .HasDatabaseName("IX_scheduled_trigger_updated_at_finished");
    }
}
