using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

internal sealed class FileBodyConfiguration : IEntityTypeConfiguration<FileBody>
{
    public void Configure(EntityTypeBuilder<FileBody> builder)
    {
        builder.ToTable(NixTables.FileBody);
        builder.HasKey(body => body.ItemId);
        builder.Property(body => body.ItemId).HasColumnName("item_id");
        builder.Property(body => body.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(body => body.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(body => body.CurrentVersionId).HasColumnName("current_version_id");
        builder.HasAlternateKey(body => new { body.TenantId, body.ItemId });
        builder.HasOne<Item>().WithOne()
            .HasForeignKey<FileBody>(body => new { body.TenantId, body.ItemId })
            .HasPrincipalKey<Item>(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(body => new { body.TenantId, body.ItemId, body.CurrentVersionId })
            .HasPrincipalKey(version => new { version.TenantId, version.ItemId, version.Id })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
