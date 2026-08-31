using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Workers;

namespace Nix.Persistence.Configurations;

/// <summary>Maps the durable rebuildable worker outbox.</summary>
internal sealed class WorkerOutboxEventConfiguration : IEntityTypeConfiguration<WorkerOutboxEvent>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkerOutboxEvent> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.WorkerOutboxEvent);
        builder.HasKey(evt => evt.Id);
        builder.Property(evt => evt.Id).HasColumnName("event_id");
        builder.Property(evt => evt.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(evt => evt.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(evt => evt.ItemId).HasColumnName("item_id");
        builder.Property(evt => evt.Kind).HasColumnName("kind").HasMaxLength(64);
        builder.Property(evt => evt.AggregateVersion).HasColumnName("aggregate_version");
        builder.Property(evt => evt.Payload).HasColumnName("payload").HasColumnType("jsonb");
        builder.Property(evt => evt.AvailableAt).HasColumnName("available_at");
        builder.Property(evt => evt.Attempts).HasColumnName("attempts");
        builder.Property(evt => evt.LeaseOwner).HasColumnName("lease_owner").HasMaxLength(128);
        builder.Property(evt => evt.LeaseUntil).HasColumnName("lease_until");
        builder.Property(evt => evt.ProcessedAt).HasColumnName("processed_at");
        builder.Property(evt => evt.LastError).HasColumnName("last_error").HasMaxLength(2000);
        builder.HasAlternateKey(evt => new { evt.TenantId, evt.Id });
        builder.HasIndex(evt => new { evt.ProcessedAt, evt.AvailableAt, evt.LeaseUntil });
        builder.HasIndex(evt => new { evt.TenantId, evt.ItemId, evt.AggregateVersion });
    }
}
