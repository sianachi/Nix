using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;

namespace Nix.Persistence.Configurations;

internal sealed class NotificationInboxConfiguration : IEntityTypeConfiguration<NotificationInbox>
{
    public void Configure(EntityTypeBuilder<NotificationInbox> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.NotificationInbox, table => table.HasCheckConstraint("notification_inbox_revision", "revision >= 0"));
        builder.HasKey(row => new { row.TenantId, row.PrincipalId });
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Revision).HasColumnName("revision");
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
