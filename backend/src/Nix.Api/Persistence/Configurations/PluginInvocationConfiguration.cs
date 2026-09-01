using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;

namespace Nix.Persistence.Configurations;

/// <summary>Maps lease-bounded plugin invocation attempts.</summary>
internal sealed class PluginInvocationConfiguration : IEntityTypeConfiguration<PluginInvocation>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginInvocation> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginInvocation);
        builder.HasKey(value => value.Id);
        builder.Property(value => value.Id).HasColumnName("invocation_id");
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.EventId).HasColumnName("event_id");
        builder.Property(value => value.InstallationId).HasColumnName("installation_id");
        builder.Property(value => value.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(value => value.Attempt).HasColumnName("attempt");
        builder.Property(value => value.CausationId).HasColumnName("causation_id");
        builder.Property(value => value.CausationDepth).HasColumnName("causation_depth");
        builder.Property(value => value.Status).HasColumnName("status").HasMaxLength(16);
        builder.Property(value => value.LeaseUntil).HasColumnName("lease_until");
        builder.Property(value => value.CompletionFingerprint).HasColumnName("completion_fingerprint");
        builder.Property(value => value.Succeeded).HasColumnName("succeeded");
        builder.Property(value => value.Retryable).HasColumnName("retryable");
        builder.Property(value => value.ErrorCode).HasColumnName("error_code").HasMaxLength(64);
        builder.Property(value => value.ErrorDetail).HasColumnName("error_detail").HasMaxLength(2000);
        builder.Property(value => value.CreatedAt).HasColumnName("created_at");
        builder.Property(value => value.CompletedAt).HasColumnName("completed_at");
        builder.HasAlternateKey(value => new { value.TenantId, value.Id });
        builder.HasIndex(value => new { value.TenantId, value.EventId, value.InstallationId, value.Attempt })
            .IsUnique();
        builder.HasIndex(value => new { value.Status, value.LeaseUntil });
        builder.HasOne<PluginEventInbox>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.EventId, value.InstallationId })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
