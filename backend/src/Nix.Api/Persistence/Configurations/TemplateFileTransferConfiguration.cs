using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Templates;

namespace Nix.Persistence.Configurations;

internal sealed class TemplateFileTransferConfiguration : IEntityTypeConfiguration<TemplateFileTransfer>
{
    public void Configure(EntityTypeBuilder<TemplateFileTransfer> builder)
    {
        builder.ToTable(NixTables.TemplateFileTransfer, table => table.HasCheckConstraint(
            "CK_template_file_transfer_owner",
            "(operation_id IS NOT NULL AND application_id IS NULL) OR (operation_id IS NULL AND application_id IS NOT NULL)"));
        builder.HasKey(transfer => transfer.Id);
        builder.Property(transfer => transfer.Id).HasColumnName("transfer_id");
        builder.Property(transfer => transfer.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(transfer => transfer.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(transfer => transfer.OperationId).HasColumnName("operation_id");
        builder.Property(transfer => transfer.ApplicationId).HasColumnName("application_id");
        builder.Property(transfer => transfer.SourceItemId).HasColumnName("source_item_id");
        builder.Property(transfer => transfer.TargetItemId).HasColumnName("target_item_id");
        builder.Property(transfer => transfer.TargetVersionId).HasColumnName("target_version_id");
        builder.Property(transfer => transfer.SourceObjectKey).HasColumnName("source_object_key").HasMaxLength(512);
        builder.Property(transfer => transfer.FileName).HasColumnName("file_name").HasMaxLength(255);
        builder.Property(transfer => transfer.MediaType).HasColumnName("media_type").HasMaxLength(160);
        builder.Property(transfer => transfer.ByteLength).HasColumnName("byte_length");
        builder.Property(transfer => transfer.Sha256).HasColumnName("sha256").HasMaxLength(64);
        builder.Property(transfer => transfer.Previewable).HasColumnName("previewable");
        builder.Property(transfer => transfer.PixelWidth).HasColumnName("pixel_width");
        builder.Property(transfer => transfer.PixelHeight).HasColumnName("pixel_height");
        builder.Property(transfer => transfer.ExecutionId).HasColumnName("execution_id").HasMaxLength(128);
        builder.HasAlternateKey(transfer => new { transfer.TenantId, transfer.Id });
        builder.HasIndex(transfer => new { transfer.TenantId, transfer.OperationId });
        builder.HasIndex(transfer => new { transfer.TenantId, transfer.ApplicationId });
        builder.HasIndex(transfer => new { transfer.TenantId, transfer.TargetVersionId }).IsUnique();
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(transfer => new { transfer.TenantId, transfer.TargetItemId, transfer.TargetVersionId })
            .HasPrincipalKey(version => new { version.TenantId, version.ItemId, version.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<TemplateOperation>().WithMany()
            .HasForeignKey(transfer => new { transfer.TenantId, transfer.OperationId })
            .HasPrincipalKey(operation => new { operation.TenantId, operation.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<TemplateApplication>().WithMany()
            .HasForeignKey(transfer => new { transfer.TenantId, transfer.ApplicationId })
            .HasPrincipalKey(application => new { application.TenantId, application.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
