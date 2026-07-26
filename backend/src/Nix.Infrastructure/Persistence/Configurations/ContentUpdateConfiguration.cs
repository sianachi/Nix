using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Content;
using Nix.Infrastructure.Persistence.Conversion;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ContentUpdate"/> to <c>content_update</c>.
/// </summary>
/// <remarks>
/// The primary key is <c>(doc_id, seq)</c>, which is also the order every read wants: catching up
/// means "everything for this document after sequence n", and that is a range scan on the key with
/// no secondary index and no sort.
/// </remarks>
internal sealed class ContentUpdateConfiguration : IEntityTypeConfiguration<ContentUpdate>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ContentUpdate> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ContentUpdate);

        builder.HasKey(update => new { update.DocId, update.Seq });

        builder.Property(update => update.DocId).HasColumnName("doc_id");
        builder.Property(update => update.Seq).HasColumnName("seq");
        builder.Property(update => update.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(update => update.UpdateBytes)
            .HasColumnName("update_bytes")
            .HasColumnType("bytea")
            .HasConversion(new BinaryPayloadConverter(), BinaryPayloadConverter.Comparer)
            .IsRequired();

        builder.Property(update => update.ActorId).HasColumnName("actor_id");
        builder.Property(update => update.ClientId).HasColumnName("client_id").IsRequired();
        builder.Property(update => update.CreatedAt).HasColumnName("created_at");

        builder.HasOne<ContentDoc>()
            .WithMany()
            .HasForeignKey(update => new { update.TenantId, update.DocId })
            .HasPrincipalKey(document => new { document.TenantId, document.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // No foreign key on actor_id. The log outlives the principals it names, for the same reason
        // the audit trail does: purging a departed person must not become either impossible or a
        // cascade that destroys the document they wrote.
    }
}
