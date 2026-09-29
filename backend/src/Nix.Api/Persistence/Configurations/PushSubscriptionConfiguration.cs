using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;

namespace Nix.Persistence.Configurations;

internal sealed class PushSubscriptionConfiguration : IEntityTypeConfiguration<PushSubscription>
{
    public void Configure(EntityTypeBuilder<PushSubscription> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PushSubscription, table => table.HasCheckConstraint(
            "push_subscription_bounded",
            "char_length(endpoint) <= 2048 AND char_length(p256dh) <= 128 AND char_length(auth) <= 64"
                + " AND char_length(user_agent) <= 400 AND failures >= 0"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Endpoint).HasColumnName("endpoint").IsRequired();
        builder.Property(row => row.P256dh).HasColumnName("p256dh").IsRequired();
        builder.Property(row => row.Auth).HasColumnName("auth").IsRequired();
        builder.Property(row => row.UserAgent).HasColumnName("user_agent").IsRequired();
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.LastSuccessAt).HasColumnName("last_success_at");
        builder.Property(row => row.Failures).HasColumnName("failures");

        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })

            // A device registration is personal state kept for the principal, not a reference to
            // them: when they are purged, their devices stop being pushed to.
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(row => new { row.TenantId, row.PrincipalId })
            .HasDatabaseName("IX_push_subscription_tenant_id_principal_id");

        // Re-subscribing the same browser (a token refresh, a re-registration after
        // pushsubscriptionchange) replaces the existing row rather than growing a duplicate.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Endpoint })
            .IsUnique()
            .HasDatabaseName("IX_push_subscription_tenant_id_principal_id_endpoint");
    }
}
