using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps workspace-scoped plugin installations.</summary>
internal sealed class PluginInstallationConfiguration : IEntityTypeConfiguration<PluginInstallation>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginInstallation> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginInstallation);
        builder.HasKey(value => value.Id);
        builder.Property(value => value.Id).HasColumnName("installation_id");
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(value => value.ComponentId).HasColumnName("component_id").HasMaxLength(257);
        builder.Property(value => value.ComponentVersion).HasColumnName("component_version").HasMaxLength(64);
        builder.Property(value => value.Enabled).HasColumnName("enabled");
        builder.Property(value => value.InstalledBy).HasColumnName("installed_by");
        builder.Property(value => value.InstalledAt).HasColumnName("installed_at");
        builder.Property(value => value.UpdatedAt).HasColumnName("updated_at");
        builder.HasAlternateKey(value => new { value.TenantId, value.Id });
        builder.HasIndex(value => new { value.TenantId, value.WorkspaceId, value.ComponentId }).IsUnique();
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.WorkspaceId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<PluginComponent>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.ComponentId, value.ComponentVersion })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
