using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

internal sealed class DocumentImportFileVersionConfiguration : IEntityTypeConfiguration<DocumentImportFileVersion>
{
    public void Configure(EntityTypeBuilder<DocumentImportFileVersion> builder)
    {
        builder.ToTable(NixTables.DocumentImportFileVersion);
        builder.HasKey(value => value.TransferId);
        builder.Property(value => value.TransferId).HasColumnName("transfer_id");
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.ImportId).HasColumnName("import_id");
        builder.Property(value => value.SourceItemId).HasColumnName("source_item_id").HasMaxLength(160);
        builder.Property(value => value.TargetItemId).HasColumnName("target_item_id");
        builder.Property(value => value.FileVersionId).HasColumnName("file_version_id");
        builder.Property(value => value.ObjectKey).HasColumnName("object_key").HasMaxLength(512);
        builder.Property(value => value.FileName).HasColumnName("file_name").HasMaxLength(255);
        builder.Property(value => value.MediaType).HasColumnName("media_type").HasMaxLength(160);
        builder.Property(value => value.ByteLength).HasColumnName("byte_length");
        builder.Property(value => value.Sha256).HasColumnName("sha256").HasMaxLength(64);
        builder.Property(value => value.Previewable).HasColumnName("previewable");
        builder.Property(value => value.PixelWidth).HasColumnName("pixel_width");
        builder.Property(value => value.PixelHeight).HasColumnName("pixel_height");
        builder.Property(value => value.ObjectReady).HasColumnName("object_ready");
        builder.Property(value => value.ExecutionId).HasColumnName("execution_id").HasMaxLength(128);
        builder.HasAlternateKey(value => new { value.TenantId, value.TransferId });
        builder.HasIndex(value => new { value.TenantId, value.ImportId, value.SourceItemId });
        builder.HasIndex(value => new { value.TenantId, value.FileVersionId }).IsUnique();
        builder.HasOne<DocumentImport>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.ImportId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.TargetItemId, value.FileVersionId })
            .HasPrincipalKey(value => new { value.TenantId, value.ItemId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.TargetItemId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
