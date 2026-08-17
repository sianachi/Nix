using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Templates;

namespace Nix.Persistence.Configurations;

/// <summary>Maps capture/import source-to-staged item identities.</summary>
internal sealed class TemplateOperationItemConfiguration : IEntityTypeConfiguration<TemplateOperationItem>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<TemplateOperationItem> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.TemplateOperationItem);
        builder.HasKey(mapping => new { mapping.OperationId, mapping.TemplateSourceId });
        builder.Property(mapping => mapping.OperationId).HasColumnName("operation_id");
        builder.Property(mapping => mapping.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(mapping => mapping.TemplateSourceId).HasColumnName("template_source_id");
        builder.Property(mapping => mapping.SourceItemId).HasColumnName("source_item_id");
        builder.Property(mapping => mapping.TargetItemId).HasColumnName("target_item_id");
        builder.Property(mapping => mapping.ItemType).HasColumnName("item_type").HasMaxLength(64);
        builder.Property(mapping => mapping.BodyRequired).HasColumnName("body_required");

        builder.HasIndex(mapping => new { mapping.TenantId, mapping.TargetItemId }).IsUnique();
        builder.HasIndex(mapping => new { mapping.TenantId, mapping.SourceItemId });

        builder.HasOne<TemplateOperation>()
            .WithMany()
            .HasForeignKey(mapping => new { mapping.TenantId, mapping.OperationId })
            .HasPrincipalKey(operation => new { operation.TenantId, operation.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Source and target identifiers are historical retry/audit data. They deliberately do not
        // own foreign keys: a source item may be purged after capture, and a staged revision is
        // removed after an active-root swap without invalidating the completed operation record.
    }
}
