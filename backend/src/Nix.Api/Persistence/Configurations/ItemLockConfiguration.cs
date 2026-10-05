using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Locks;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemLock"/> to <c>item_lock</c>.
/// </summary>
/// <remarks>
/// A table of its own rather than a column on <c>item</c>, so the verifier is never in a row any
/// item read projects. Every tree, board and search statement selects from <c>item</c>; none of
/// them can leak a column that is not there.
/// </remarks>
internal sealed class ItemLockConfiguration : IEntityTypeConfiguration<ItemLock>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemLock> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemLock);

        // One lock per item: a second password on the same body would be two locks that must agree.
        builder.HasKey(itemLock => itemLock.ItemId);

        // The tenant-qualified key grants reference, so a grant can only ever name a lock in its
        // own tenant - a foreign key check ignores row-level security, so the schema has to say it.
        // It is also the index every lock probe uses, since each one filters on the tenant too.
        builder.HasAlternateKey(itemLock => new { itemLock.TenantId, itemLock.ItemId });

        builder.Property(itemLock => itemLock.ItemId).HasColumnName("item_id");
        builder.Property(itemLock => itemLock.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(itemLock => itemLock.PasswordHash).HasColumnName("password_hash").IsRequired();
        builder.Property(itemLock => itemLock.LockedBy).HasColumnName("locked_by");
        builder.Property(itemLock => itemLock.LockedAt).HasColumnName("locked_at");

        // The lock is part of the item: purging the item takes the lock with it.
        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(itemLock => new { itemLock.TenantId, itemLock.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // No foreign key on locked_by, for the reason content_version.created_by has none: a lock
        // must outlive the principal who set it rather than vanish, or block their removal.
    }
}
