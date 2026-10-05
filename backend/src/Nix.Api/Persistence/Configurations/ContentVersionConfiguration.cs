using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Content;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ContentVersion"/> to <c>content_version</c>.
/// </summary>
/// <remarks>
/// Keyed the same way as <c>content_snapshot</c>, for the same reason: a version is addressed by
/// the document and the sequence it names, and "is there a name at this seq" is then a point lookup
/// on the primary key rather than a scan.
/// </remarks>
internal sealed class ContentVersionConfiguration : IEntityTypeConfiguration<ContentVersion>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ContentVersion> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ContentVersion);

        builder.HasKey(version => new { version.DocId, version.Seq });

        builder.Property(version => version.DocId).HasColumnName("doc_id");
        builder.Property(version => version.Seq).HasColumnName("seq");
        builder.Property(version => version.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(version => version.Name).HasColumnName("name").IsRequired();
        builder.Property(version => version.CreatedBy).HasColumnName("created_by").IsRequired();
        builder.Property(version => version.CreatedAt).HasColumnName("created_at");

        builder.HasOne<ContentDoc>()
            .WithMany()
            .HasForeignKey(version => new { version.TenantId, version.DocId })
            .HasPrincipalKey(document => new { document.TenantId, document.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // No foreign key on created_by, for the same reason content_update.actor_id has none: a
        // named version must outlive the principal who named it, not disappear or block their
        // removal.
    }
}
