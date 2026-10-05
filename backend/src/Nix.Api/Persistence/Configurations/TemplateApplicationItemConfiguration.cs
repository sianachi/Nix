using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Templates;

namespace Nix.Persistence.Configurations;

/// <summary>Maps stable source-to-target item identities.</summary>
internal sealed class TemplateApplicationItemConfiguration : IEntityTypeConfiguration<TemplateApplicationItem>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<TemplateApplicationItem> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.TemplateApplicationItem);
        builder.HasKey(mapping => new { mapping.ApplicationId, mapping.TemplateSourceId });
        builder.Property(mapping => mapping.ApplicationId).HasColumnName("application_id");
        builder.Property(mapping => mapping.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(mapping => mapping.TemplateSourceId).HasColumnName("template_source_id");
        builder.Property(mapping => mapping.SourceItemId).HasColumnName("source_item_id");
        builder.Property(mapping => mapping.ItemType).HasColumnName("item_type").HasMaxLength(64);
        builder.Property(mapping => mapping.TargetItemId).HasColumnName("target_item_id");
        builder.Property(mapping => mapping.IsRoot).HasColumnName("is_root");
        builder.Property(mapping => mapping.Created).HasColumnName("created");
        builder.Property(mapping => mapping.BodyRequired).HasColumnName("body_required");

        builder.HasIndex(mapping => new { mapping.TenantId, mapping.TargetItemId });

        builder.HasOne<TemplateApplication>()
            .WithMany()
            .HasForeignKey(mapping => new { mapping.TenantId, mapping.ApplicationId })
            .HasPrincipalKey(application => new { application.TenantId, application.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Both identifiers are historical mapping tombstones, not ownership. Keeping them after a
        // target is purged prevents a later reapplication from resurrecting a deliberately deleted
        // child, while avoiding a restrictive FK that would make ordinary item purge fail.
    }
}
