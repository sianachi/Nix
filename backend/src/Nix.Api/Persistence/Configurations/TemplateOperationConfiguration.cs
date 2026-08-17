using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>Maps staged capture/import operations.</summary>
internal sealed class TemplateOperationConfiguration : IEntityTypeConfiguration<TemplateOperation>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<TemplateOperation> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.TemplateOperation);
        builder.HasKey(operation => operation.Id);
        builder.Property(operation => operation.Id).HasColumnName("operation_id");
        builder.Property(operation => operation.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(operation => operation.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(operation => operation.TemplateId).HasColumnName("template_id");
        builder.Property(operation => operation.Kind)
            .HasColumnName("kind")
            .HasConversion(new EnumConverters.TemplateOperationKindConverter());
        builder.Property(operation => operation.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160);
        builder.Property(operation => operation.SourceItemId).HasColumnName("source_item_id");
        builder.Property(operation => operation.ActorId).HasColumnName("actor_id");
        builder.Property(operation => operation.DraftTitle).HasColumnName("draft_title").HasMaxLength(200);
        builder.Property(operation => operation.DraftDescription).HasColumnName("draft_description").HasMaxLength(1000);
        builder.Property(operation => operation.ManagedSource).HasColumnName("managed_source").HasMaxLength(500);
        builder.Property(operation => operation.SourceDigest).HasColumnName("source_digest").HasMaxLength(128);
        builder.Property(operation => operation.State)
            .HasColumnName("state")
            .HasConversion(new EnumConverters.TemplateOperationStateConverter());
        builder.Property(operation => operation.CreatedAt).HasColumnName("created_at");
        builder.Property(operation => operation.ExpiresAt).HasColumnName("expires_at");
        builder.Property(operation => operation.FinalizedAt).HasColumnName("finalized_at");

        builder.HasAlternateKey(operation => new { operation.TenantId, operation.Id });
        builder.HasIndex(operation => new { operation.TenantId, operation.ActorId, operation.IdempotencyKey })
            .IsUnique();
        builder.HasIndex(operation => new
        {
            operation.TenantId,
            operation.WorkspaceId,
            operation.State,
            operation.ExpiresAt,
        });

        builder.HasOne<WorkspaceTemplate>()
            .WithMany()
            .HasForeignKey(operation => new { operation.TenantId, operation.TemplateId })
            .HasPrincipalKey(template => new { template.TenantId, template.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(operation => new { operation.TenantId, operation.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
