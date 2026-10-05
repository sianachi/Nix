using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Links;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemSearchEntry"/> to <c>item_search</c>.
/// </summary>
/// <remarks>
/// The <c>body_vector</c> column this table exists for is deliberately absent from the model. It
/// is a <c>tsvector</c>, which no domain type can express without taking a dependency on Npgsql,
/// and nothing in Core ever wants it as a .NET value: the collaboration service writes it and one
/// hand-written statement matches against it. The migration's hand-written half adds the column
/// and its GIN index. EF never having known about it is what keeps a later scaffold from
/// proposing to drop it.
/// </remarks>
internal sealed class ItemSearchEntryConfiguration : IEntityTypeConfiguration<ItemSearchEntry>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemSearchEntry> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemSearch);

        builder.HasKey(entry => new { entry.TenantId, entry.ItemId });

        builder.Property(entry => entry.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(entry => entry.ItemId).HasColumnName("item_id");
        builder.Property(entry => entry.Seq).HasColumnName("seq");
        builder.Property(entry => entry.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(entry => new { entry.TenantId, entry.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
