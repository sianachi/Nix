using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Transcriptions;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="ItemTranscription"/> to <c>item_transcription</c>.
/// </summary>
internal sealed class ItemTranscriptionConfiguration : IEntityTypeConfiguration<ItemTranscription>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemTranscription> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemTranscription);

        // One current transcription per audio item, the same key shape as item_lock: the item id
        // alone is the key, and the tenant-qualified foreign key below is what stops a row naming
        // an item in another tenant - a foreign key check ignores row-level security.
        builder.HasKey(transcription => transcription.AudioItemId);

        builder.Property(transcription => transcription.AudioItemId).HasColumnName("audio_item_id");
        builder.Property(transcription => transcription.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(transcription => transcription.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(transcription => transcription.NoteItemId).HasColumnName("note_item_id");
        builder.Property(transcription => transcription.JobId).HasColumnName("job_id");
        builder.Property(transcription => transcription.Speakers).HasColumnName("speakers").HasMaxLength(16);
        builder.Property(transcription => transcription.Progress).HasColumnName("progress");
        builder.Property(transcription => transcription.RequestedBy).HasColumnName("requested_by");
        builder.Property(transcription => transcription.CreatedAt).HasColumnName("created_at");
        builder.Property(transcription => transcription.UpdatedAt).HasColumnName("updated_at");

        // The row is state about the audio item and nothing else owns it: purging the item, or the
        // workspace above it, takes the row with it, as it takes item_lock and file_body. Soft
        // deletion leaves it alone - a restored recording keeps its transcription status.
        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(transcription => new { transcription.TenantId, transcription.AudioItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Deliberately no foreign key on the other four references:
        //  - note_item_id and workspace_id record where the transcript was sent when the job was
        //    started. Every use re-reads the note through the item tree as the acting principal,
        //    so a note purged or moved since is refused there; a key would instead either block
        //    the note's purge or delete the status of a recording that still exists.
        //  - job_id names a worker_job row, and worker_job is restricted, not cascaded, from its
        //    workspace. A key here would put this table in the way of however jobs are retired.
        //    A row whose job is gone reads as "no transcription".
        //  - requested_by, for the reason item_lock.locked_by has none: the record must not
        //    vanish with, or block the removal of, the principal who asked.
    }
}
