using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Content;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ContentDoc"/> to <c>content_doc</c>.
/// </summary>
internal sealed class ContentDocConfiguration : IEntityTypeConfiguration<ContentDoc>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ContentDoc> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ContentDoc);

        builder.HasKey(document => document.Id);
        builder.Property(document => document.Id).HasColumnName("doc_id");
        builder.Property(document => document.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(document => document.ItemId).HasColumnName("item_id");
        builder.Property(document => document.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(document => document.SchemaVersion).HasColumnName("schema_version");
        builder.Property(document => document.HeadSeq).HasColumnName("head_seq");
        builder.Property(document => document.CreatedAt).HasColumnName("created_at");

        // The target of the composite references from the log and the snapshots.
        builder.HasAlternateKey(document => new { document.TenantId, document.Id });

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(document => new { document.TenantId, document.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })

            // Cascade, unlike the item tree's other references. A document is the item's body
            // rather than something that merely points at it: an item without content is a
            // sensible row, but content whose item has gone is unreachable by construction, since
            // permissions are resolved through the item.
            .OnDelete(DeleteBehavior.Cascade);

        // One document per item. The body is the item's, not one of several.
        builder.HasIndex(document => new { document.TenantId, document.ItemId }).IsUnique();
    }
}
