using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Locks;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemUnlock"/> to <c>item_unlock</c>.
/// </summary>
internal sealed class ItemUnlockConfiguration : IEntityTypeConfiguration<ItemUnlock>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemUnlock> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemUnlock);

        // One grant per credential per item; unlocking again moves its expiry rather than stacking.
        builder.HasKey(unlock => new { unlock.ItemId, unlock.CredentialId });

        builder.Property(unlock => unlock.ItemId).HasColumnName("item_id");
        builder.Property(unlock => unlock.CredentialId).HasColumnName("credential_id");
        builder.Property(unlock => unlock.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(unlock => unlock.PrincipalId).HasColumnName("principal_id");
        builder.Property(unlock => unlock.ExpiresAt).HasColumnName("expires_at");

        // Hangs off the lock, not the item, so removing the lock deletes its grants with it. Changing
        // the password deletes them in the same transaction (ItemLockStore), so no grant outlives the
        // password it was issued against.
        builder.HasOne<ItemLock>()
            .WithMany()
            .HasForeignKey(unlock => new { unlock.TenantId, unlock.ItemId })
            .HasPrincipalKey(itemLock => new { itemLock.TenantId, itemLock.ItemId })
            .OnDelete(DeleteBehavior.Cascade);

        // No foreign key on credential_id: it names a browser session or an access token, two
        // tables, and a grant for a credential that has ended is inert because the credential no
        // longer authenticates anything.
    }
}
