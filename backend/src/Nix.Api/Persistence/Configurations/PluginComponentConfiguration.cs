using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Plugins;

namespace Nix.Persistence.Configurations;

/// <summary>Maps immutable signed plugin component versions.</summary>
internal sealed class PluginComponentConfiguration : IEntityTypeConfiguration<PluginComponent>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PluginComponent> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PluginComponent);
        builder.HasKey(value => new { value.TenantId, value.Id, value.Version });
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.PublisherId).HasColumnName("publisher_id").HasMaxLength(128);
        builder.Property(value => value.Id).HasColumnName("component_id").HasMaxLength(257);
        builder.Property(value => value.Version).HasColumnName("component_version").HasMaxLength(64);
        builder.Property(value => value.ObjectKey).HasColumnName("object_key").HasMaxLength(1024);
        builder.Property(value => value.Sha256).HasColumnName("sha256").HasMaxLength(64);
        builder.Property(value => value.ByteLength).HasColumnName("byte_length");
        builder.Property(value => value.Ed25519Signature).HasColumnName("ed25519_signature");
        builder.Property(value => value.RegisteredBy).HasColumnName("registered_by");
        builder.Property(value => value.RegisteredAt).HasColumnName("registered_at");
        builder.HasOne<PluginPublisher>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.PublisherId })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
