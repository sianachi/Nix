using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Persistence.Configurations;

internal sealed class DocumentImportConfiguration : IEntityTypeConfiguration<DocumentImport>
{
    public void Configure(EntityTypeBuilder<DocumentImport> builder)
    {
        builder.ToTable(NixTables.DocumentImport);
        builder.HasKey(value => value.Id);
        builder.Property(value => value.Id).HasColumnName("import_id");
        builder.Property(value => value.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(value => value.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(value => value.ActorId).HasColumnName("actor_id");
        builder.Property(value => value.UploadId).HasColumnName("upload_id");
        builder.Property(value => value.ParentId).HasColumnName("parent_id");
        builder.Property(value => value.Purpose).HasColumnName("purpose").HasMaxLength(32);
        builder.Property(value => value.ManagedSource).HasColumnName("managed_source").HasMaxLength(500);
        builder.Property(value => value.Format).HasColumnName("format").HasMaxLength(32);
        builder.Property(value => value.Title).HasColumnName("title").HasMaxLength(500);
        builder.Property(value => value.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160);
        builder.Property(value => value.Status).HasColumnName("status").HasMaxLength(32);
        builder.Property(value => value.PreviewJobId).HasColumnName("preview_job_id");
        builder.Property(value => value.CommitJobId).HasColumnName("commit_job_id");
        builder.Property(value => value.PlanObjectKey).HasColumnName("plan_object_key").HasMaxLength(512);
        builder.Property(value => value.PlanSha256).HasColumnName("plan_sha256").HasMaxLength(64);
        builder.Property(value => value.PlanByteLength).HasColumnName("plan_byte_length");
        builder.Property(value => value.SourceSha256).HasColumnName("source_sha256").HasMaxLength(64);
        builder.Property(value => value.ItemCount).HasColumnName("item_count");
        builder.Property(value => value.AssetCount).HasColumnName("asset_count");
        builder.Property(value => value.Loss).HasColumnName("loss").HasColumnType("jsonb");
        builder.Property(value => value.Omissions).HasColumnName("omissions").HasColumnType("jsonb");
        builder.Property(value => value.TemplatePreview).HasColumnName("template_preview").HasColumnType("jsonb");
        builder.Property(value => value.TemplateOperationId).HasColumnName("template_operation_id");
        builder.Property(value => value.TemplateId).HasColumnName("template_id");
        builder.Property(value => value.TemplateStableKey).HasColumnName("template_stable_key").HasMaxLength(160);
        builder.Property(value => value.TemplateDigest).HasColumnName("template_digest").HasMaxLength(64);
        builder.Property(value => value.TemplateUnchanged).HasColumnName("template_unchanged");
        builder.Property(value => value.TemplateWrittenTargetItemIds)
            .HasColumnName("template_written_target_item_ids")
            .HasColumnType("jsonb");
        builder.Property(value => value.RootItemId).HasColumnName("root_item_id");
        builder.Property(value => value.FailureCode).HasColumnName("failure_code").HasMaxLength(80);
        builder.Property(value => value.ExpiresAt).HasColumnName("expires_at");
        builder.Property(value => value.CreatedAt).HasColumnName("created_at");
        builder.Property(value => value.UpdatedAt).HasColumnName("updated_at");
        builder.Property(value => value.CompletedAt).HasColumnName("completed_at");
        builder.HasAlternateKey(value => new { value.TenantId, value.Id });
        builder.HasIndex(value => new { value.TenantId, value.ActorId, value.IdempotencyKey }).IsUnique();
        builder.HasIndex(value => new { value.Status, value.ExpiresAt });
        builder.HasIndex(value => new { value.TenantId, value.TemplateId });
        builder.HasIndex(value => new { value.TenantId, value.TemplateOperationId });
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.WorkspaceId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<FileUpload>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.UploadId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.RootItemId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Restrict);
        // Template and staging-operation identifiers are immutable audit facts, not ownership
        // links. Keeping foreign keys here would prevent deleting a user template and pruning
        // terminal managed operations while retaining the durable import history.
        builder.HasOne<WorkerJob>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.PreviewJobId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<WorkerJob>().WithMany()
            .HasForeignKey(value => new { value.TenantId, value.CommitJobId })
            .HasPrincipalKey(value => new { value.TenantId, value.Id })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
