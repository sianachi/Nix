using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Tenancy;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Workspace"/> to <c>workspace</c>.
/// </summary>
/// <remarks>
/// Carries the alternate key on <c>(tenant_id, workspace_id)</c> that every workspace-referencing
/// table points at. See <see cref="ItemConfiguration"/> for why the references are composite.
/// </remarks>
internal sealed class WorkspaceConfiguration : IEntityTypeConfiguration<Workspace>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Workspace> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.Workspace);

        builder.HasKey(workspace => workspace.Id);
        builder.Property(workspace => workspace.Id).HasColumnName("workspace_id");
        builder.Property(workspace => workspace.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(workspace => workspace.Name).HasColumnName("name").IsRequired();
        builder.Property(workspace => workspace.VersionRetentionDays).HasColumnName("version_retention_days");
        builder.Property(workspace => workspace.CoalesceWindowMinutes).HasColumnName("coalesce_window_min");
        builder.Property(workspace => workspace.StorageQuotaBytes).HasColumnName("storage_quota_bytes");
        builder.Property(workspace => workspace.CreatedAt).HasColumnName("created_at").IsRequired();

        // The target of every composite tenant-scoped reference to a workspace.
        builder.HasAlternateKey(workspace => new { workspace.TenantId, workspace.Id });

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(workspace => workspace.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        // No standalone tenant_id index: it is a strict prefix of the alternate key above.
    }
}
