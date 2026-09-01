using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

internal sealed class DocumentImportItemConfiguration : IEntityTypeConfiguration<DocumentImportItem>
{
    public void Configure(EntityTypeBuilder<DocumentImportItem> builder)
    {
        builder.ToTable(NixTables.DocumentImportItem);
        builder.HasKey(value => new { value.ImportId, value.SourceId });
        builder.Property(value => value.ImportId).HasColumnName("import_id");
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.SourceId).HasColumnName("source_id").HasMaxLength(160);
        builder.Property(value => value.ParentSourceId).HasColumnName("parent_source_id").HasMaxLength(160);
        builder.Property(value => value.TargetItemId).HasColumnName("target_item_id");
        builder.Property(value => value.ItemType).HasColumnName("item_type").HasMaxLength(64);
        builder.Property(value => value.FinalLifecycleState).HasColumnName("final_lifecycle_state").HasMaxLength(16);
        builder.Property(value => value.BodyRequired).HasColumnName("body_required");
        builder.Property(value => value.FileVersionId).HasColumnName("file_version_id");
        builder.Property(value => value.ObjectKey).HasColumnName("object_key").HasMaxLength(512);
        builder.Property(value => value.ObjectReady).HasColumnName("object_ready");
        builder.HasIndex(value => new { value.TenantId, value.TargetItemId }).IsUnique();
        builder.HasOne<DocumentImport>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.ImportId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.FileVersionId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.TargetItemId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
