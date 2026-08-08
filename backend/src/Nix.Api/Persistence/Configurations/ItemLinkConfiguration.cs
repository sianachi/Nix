using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Links;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemLink"/> to <c>item_link</c>.
/// </summary>
/// <remarks>
/// <para>
/// Keyed on the ordered pair, so a document that mentions the same target repeatedly is one row
/// with a count rather than a row per mention, and re-extracting a document is an upsert rather
/// than a delete-and-reinsert of edges that did not change.
/// </para>
/// <para>
/// Both references are composite on <c>tenant_id</c>, for the reason spelled out at length in
/// <see cref="ItemConfiguration"/>: foreign key checks run with the referenced table's owner
/// privileges and are not subject to row-level security, so a plain
/// <c>target_item_id -&gt; item(id)</c> would be satisfied by another tenant's row. Referencing the
/// alternate key makes a cross-tenant edge fail at the constraint.
/// </para>
/// <para>
/// Both cascade. An item that is purged takes with it every edge into it and every edge out of it;
/// leaving either behind would give the backlinks panel rows pointing at nothing, which it would
/// then have to filter on every read.
/// </para>
/// </remarks>
internal sealed class ItemLinkConfiguration : IEntityTypeConfiguration<ItemLink>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemLink> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemLink);

        builder.HasKey(link => new { link.TenantId, link.SourceItemId, link.TargetItemId });

        builder.Property(link => link.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(link => link.SourceItemId).HasColumnName("source_item_id");
        builder.Property(link => link.TargetItemId).HasColumnName("target_item_id");
        builder.Property(link => link.Occurrences).HasColumnName("occurrences");
        builder.Property(link => link.Seq).HasColumnName("seq");

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.SourceItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.TargetItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // The backlinks query reads by target: "what points at the item I am looking at". The
        // primary key leads with the source, so it cannot serve that direction at all.
        builder.HasIndex(link => new { link.TenantId, link.TargetItemId })
            .HasDatabaseName("ix_item_link_target");
    }
}
