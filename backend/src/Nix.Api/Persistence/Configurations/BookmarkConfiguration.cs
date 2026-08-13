using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Bookmarks;
using Nix.Domain.Identity;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Bookmark"/> to <c>bookmark</c>.
/// </summary>
internal sealed class BookmarkConfiguration : IEntityTypeConfiguration<Bookmark>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Bookmark> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.Bookmark);

        // One row per person per item: bookmarking something twice is the same shelf, not two
        // entries, and the key is what makes that true rather than something the application has to
        // remember to check.
        builder.HasKey(bookmark => new { bookmark.PrincipalId, bookmark.ItemId });

        builder.Property(bookmark => bookmark.PrincipalId).HasColumnName("principal_id");
        builder.Property(bookmark => bookmark.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(bookmark => bookmark.ItemId).HasColumnName("item_id");
        builder.Property(bookmark => bookmark.CreatedAt).HasColumnName("created_at");

        // Assigned by the database, so two tabs keeping something at the same moment cannot both
        // claim the same position. `ValueGeneratedOnAdd` keeps EF from writing the CLR default over
        // the sequence's answer.
        builder.Property(bookmark => bookmark.Seq)
            .HasColumnName("seq")
            .ValueGeneratedOnAdd();

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(bookmark => new { bookmark.TenantId, bookmark.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })

            // A shelf is personal state kept for the principal, not a reference to them - it goes
            // when they do, the same way canvas_library does.
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(bookmark => bookmark.ItemId)

            // The whole reason this is a table rather than a list of identifiers in a blob. An item
            // that is purged takes its bookmarks with it, so no read has to filter out references to
            // things that no longer exist - and nobody keeps a shelf of dead links.
            .OnDelete(DeleteBehavior.Cascade);

        // The list read is "this principal's bookmarks, newest first", and it is the only read.
        builder.HasIndex(bookmark => new { bookmark.TenantId, bookmark.PrincipalId, bookmark.Seq })
            .HasDatabaseName("IX_bookmark_tenant_id_principal_id_seq");
    }
}
