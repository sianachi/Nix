using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Content;
using Nix.Domain.Identity;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="CanvasLibrary"/> to <c>canvas_library</c>.
/// </summary>
internal sealed class CanvasLibraryConfiguration : IEntityTypeConfiguration<CanvasLibrary>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<CanvasLibrary> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.CanvasLibrary);

        builder.HasKey(library => library.PrincipalId);
        builder.Property(library => library.PrincipalId).HasColumnName("principal_id");
        builder.Property(library => library.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(library => library.LibraryItemsJson)
            .HasColumnName("library_items")
            .HasColumnType("jsonb");

        builder.Property(library => library.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(library => new { library.TenantId, library.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })

            // A library is personal state kept for the principal, not a reference to them - it
            // goes when they do, the same way content_doc goes when its item does.
            .OnDelete(DeleteBehavior.Cascade);
    }
}
