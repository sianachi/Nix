using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;

namespace Nix.Persistence.Configurations;

/// <summary>Maps tenant-pinned plugin publisher keys.</summary>
internal sealed class PluginPublisherConfiguration : IEntityTypeConfiguration<PluginPublisher>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginPublisher> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginPublisher);
        builder.HasKey(value => new { value.TenantId, value.Id });
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.Id).HasColumnName("publisher_id").HasMaxLength(128);
        builder.Property(value => value.Ed25519PublicKey).HasColumnName("ed25519_public_key");
        builder.Property(value => value.PinnedBy).HasColumnName("pinned_by");
        builder.Property(value => value.PinnedAt).HasColumnName("pinned_at");
    }
}
