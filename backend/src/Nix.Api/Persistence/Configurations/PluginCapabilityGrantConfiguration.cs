using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;

namespace Nix.Persistence.Configurations;

/// <summary>Maps explicit plugin host capability grants.</summary>
internal sealed class PluginCapabilityGrantConfiguration : IEntityTypeConfiguration<PluginCapabilityGrant>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginCapabilityGrant> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginCapabilityGrant);
        builder.HasKey(value => new { value.TenantId, value.InstallationId, value.Capability });
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.InstallationId).HasColumnName("installation_id");
        builder.Property(value => value.Capability).HasColumnName("capability").HasMaxLength(64);
        builder.Property(value => value.GrantedBy).HasColumnName("granted_by");
        builder.Property(value => value.GrantedAt).HasColumnName("granted_at");
        builder.HasOne<PluginInstallation>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.InstallationId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
