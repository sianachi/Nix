using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemClosureEdge"/> to <c>item_closure</c>.
/// </summary>
/// <remarks>
/// <para>
/// The table is read from both ends and both are on the hot path: "every ancestor of this item"
/// is the permission question, "every descendant of this item" is the subtree question, and
/// neither index can serve the other.
/// </para>
/// <para>
/// Both are tenant-prefixed, which is what lets the row-level security predicate be hoisted into
/// an index condition and evaluated once per scan rather than once per row - measured at ~54ns a
/// row when it lands in filter position instead. An earlier draft carried an
/// <c>(ancestor_id, depth)</c> index without the tenant prefix; the planner never chose it under
/// the runtime role, only under the migrator's <c>BYPASSRLS</c>, which is why measuring as the
/// wrong role is worse than not measuring.
/// </para>
/// </remarks>
internal sealed class ItemClosureEdgeConfiguration : IEntityTypeConfiguration<ItemClosureEdge>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemClosureEdge> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemClosure);

        builder.HasKey(edge => new { edge.DescendantId, edge.AncestorId });

        builder.Property(edge => edge.DescendantId).HasColumnName("descendant_id");
        builder.Property(edge => edge.AncestorId).HasColumnName("ancestor_id");
        builder.Property(edge => edge.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(edge => edge.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(edge => edge.Depth).HasColumnName("depth");

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(edge => new { edge.TenantId, edge.DescendantId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(edge => new { edge.TenantId, edge.AncestorId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Descendants of an ancestor, nearest first. Carrying depth as a third key column rather
        // than leaving it to a heap filter is what makes "the direct children of this item"
        // (depth = 1) an index condition; measured at 5 buffers against 68 for the filtered form.
        // This index also covers the (tenant_id, ancestor_id) foreign key, so EF emits no separate
        // one for it.
        builder.HasIndex(edge => new { edge.TenantId, edge.AncestorId, edge.Depth });

        // No standalone tenant_id index: a strict prefix of the above and of the descendant-side
        // foreign key index. On a table that writes depth+1 rows per item created, an index that
        // can serve no query of its own is pure write amplification.
    }
}
