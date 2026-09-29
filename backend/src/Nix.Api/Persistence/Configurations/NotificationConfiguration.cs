using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;

namespace Nix.Persistence.Configurations;

internal sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.Notification, table => table.HasCheckConstraint(
            "notification_bounded",
            "char_length(title) <= 200 AND char_length(body) <= 1000"
                + " AND kind IN ('reminder', 'automation', 'calendar', 'system')"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Kind)
            .HasColumnName("kind")
            .HasConversion(
                kind => NotificationKindStorage.ToText(kind),
                stored => NotificationKindStorage.FromText(stored))
            .HasMaxLength(16)
            .IsRequired();
        builder.Property(row => row.Title).HasColumnName("title").IsRequired();
        builder.Property(row => row.Body).HasColumnName("body").IsRequired();
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.Seq).HasColumnName("seq").ValueGeneratedOnAdd();
        builder.Property(row => row.ReadAt).HasColumnName("read_at");
        builder.Property(row => row.DedupeKey).HasColumnName("dedupe_key").HasMaxLength(200).IsRequired();

        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })

            // Notifications are personal state addressed to the principal, not a reference to
            // them: when they are purged, their inbox goes with them.
            .OnDelete(DeleteBehavior.Cascade);

        // The only list read: this principal's inbox, newest first, optionally filtered to unread.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Seq })
            .HasDatabaseName("IX_notification_tenant_id_principal_id_seq");

        // Creating a notification is idempotent per tenant: a repeated dedupe key (a redelivered
        // trigger, a retried worker call) returns the row that already exists.
        builder.HasIndex(row => new { row.TenantId, row.DedupeKey })
            .IsUnique()
            .HasDatabaseName("IX_notification_tenant_id_dedupe_key");
    }
}
