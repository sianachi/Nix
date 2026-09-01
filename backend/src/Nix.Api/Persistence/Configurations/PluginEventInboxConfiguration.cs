using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;

namespace Nix.Persistence.Configurations;

/// <summary>Maps event-and-installation deduplication state.</summary>
internal sealed class PluginEventInboxConfiguration : IEntityTypeConfiguration<PluginEventInbox>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginEventInbox> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginEventInbox);
        builder.HasKey(value => new { value.TenantId, value.EventId, value.InstallationId });
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.EventId).HasColumnName("event_id");
        builder.Property(value => value.InstallationId).HasColumnName("installation_id");
        builder.Property(value => value.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(value => value.Kind).HasColumnName("kind").HasMaxLength(64);
        builder.Property(value => value.ItemId).HasColumnName("item_id");
        builder.Property(value => value.AggregateVersion).HasColumnName("aggregate_version");
        builder.Property(value => value.CausationId).HasColumnName("causation_id");
        builder.Property(value => value.CausationDepth).HasColumnName("causation_depth");
        builder.Property(value => value.Status).HasColumnName("status").HasMaxLength(16);
        builder.Property(value => value.Attempts).HasColumnName("attempts");
        builder.Property(value => value.CurrentInvocationId).HasColumnName("current_invocation_id");
        builder.Property(value => value.ErrorCode).HasColumnName("error_code").HasMaxLength(64);
        builder.Property(value => value.ErrorDetail).HasColumnName("error_detail").HasMaxLength(2000);
        builder.Property(value => value.CreatedAt).HasColumnName("created_at");
        builder.Property(value => value.UpdatedAt).HasColumnName("updated_at");
        builder.Property(value => value.CompletedAt).HasColumnName("completed_at");
        builder.HasIndex(value => new { value.Status, value.UpdatedAt });
        builder.HasOne<PluginEventReceipt>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.EventId })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<PluginInstallation>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.InstallationId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
