using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps immutable identifier-only plugin event receipts.</summary>
internal sealed class PluginEventReceiptConfiguration : IEntityTypeConfiguration<PluginEventReceipt>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginEventReceipt> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginEventReceipt);
        builder.HasKey(value => new { value.TenantId, value.EventId });
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.EventId).HasColumnName("event_id");
        builder.Property(value => value.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(value => value.Kind).HasColumnName("kind").HasMaxLength(64);
        builder.Property(value => value.ItemId).HasColumnName("item_id");
        builder.Property(value => value.AggregateVersion).HasColumnName("aggregate_version");
        builder.Property(value => value.CausationId).HasColumnName("causation_id");
        builder.Property(value => value.CausationDepth).HasColumnName("causation_depth");
        builder.Property(value => value.ReceivedAt).HasColumnName("received_at");
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.WorkspaceId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
