using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Content;
using Nix.Infrastructure.Persistence.Conversion;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ContentSnapshot"/> to <c>content_snapshot</c>.
/// </summary>
/// <remarks>
/// Keyed the same way as the log, so "the newest snapshot at or before sequence n" is a backwards
/// range scan of one row rather than an aggregate. Opening a document is exactly that query
/// followed by the updates after it.
/// </remarks>
internal sealed class ContentSnapshotConfiguration : IEntityTypeConfiguration<ContentSnapshot>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ContentSnapshot> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ContentSnapshot);

        builder.HasKey(snapshot => new { snapshot.DocId, snapshot.Seq });

        builder.Property(snapshot => snapshot.DocId).HasColumnName("doc_id");
        builder.Property(snapshot => snapshot.Seq).HasColumnName("seq");
        builder.Property(snapshot => snapshot.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(snapshot => snapshot.YjsState)
            .HasColumnName("yjs_state")
            .HasColumnType("bytea")
            .HasConversion(new BinaryPayloadConverter(), BinaryPayloadConverter.Comparer)
            .IsRequired();

        builder.Property(snapshot => snapshot.ProseMirrorJson)
            .HasColumnName("prosemirror_json")
            .HasColumnType("jsonb");

        builder.Property(snapshot => snapshot.Plaintext).HasColumnName("plaintext");
        builder.Property(snapshot => snapshot.CreatedAt).HasColumnName("created_at");

        builder.HasOne<ContentDoc>()
            .WithMany()
            .HasForeignKey(snapshot => new { snapshot.TenantId, snapshot.DocId })
            .HasPrincipalKey(document => new { document.TenantId, document.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
