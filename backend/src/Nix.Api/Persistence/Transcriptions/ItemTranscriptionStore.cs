using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Transcriptions;
using Nix.Domain.Items;
using Nix.Domain.Transcriptions;
using Nix.Domain.Workers;
using Npgsql;

namespace Nix.Persistence.Transcriptions;

/// <summary>
/// Reads and writes <c>item_transcription</c> inside the current unit of work.
/// </summary>
/// <remarks>
/// The tenant comes from the session and is written into every predicate as well as being enforced
/// by row-level security. The predicate does nothing for the plan - every statement here finds its
/// row by the primary key, <c>audio_item_id</c> - it is there so a statement stays correct if it
/// is ever run by a role the policy does not bind, and so the tenant a row must belong to is
/// visible where the statement is read.
/// </remarks>
public sealed class ItemTranscriptionStore(
    NixDbContext database,
    INixSessionContextAccessor session,
    TimeProvider clock) : IItemTranscriptionStore
{
    private NixSessionContext Session => session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A transcription "
            + "belongs to a tenant; there is no anonymous path.");

    /// <inheritdoc />
    public async ValueTask SerializeStartsAsync(ItemId audioItemId, CancellationToken cancellationToken)
    {
        var key = $"item-transcription:{Session.TenantId.Value:N}:{audioItemId.Value:N}";
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({key}, 0))",
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<ItemTranscriptionRecord?> FindAsync(ItemId audioItemId, CancellationToken cancellationToken)
    {
        var tenantId = Session.TenantId;

        // The join is the whole of the non-actor read: a job is reachable only as the job a
        // transcription row of this tenant names, and only its lifecycle columns are projected.
        var row = await (
            from transcription in database.ItemTranscriptions.AsNoTracking()
            join job in database.WorkerJobs.AsNoTracking()
                on new { transcription.TenantId, Id = transcription.JobId }
                equals new { job.TenantId, job.Id }
            where transcription.TenantId == tenantId
                && transcription.AudioItemId == audioItemId
                && job.Kind == TranscriptionJob.Kind
            select new
            {
                transcription.AudioItemId,
                transcription.NoteItemId,
                transcription.WorkspaceId,
                transcription.JobId,
                transcription.Speakers,
                transcription.Progress,
                job.Status,
                job.ErrorCode,
                job.CreatedAt,
                job.CompletedAt,
            }).SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);

        return row is null
            ? null
            : new ItemTranscriptionRecord(
                row.AudioItemId,
                row.NoteItemId,
                row.WorkspaceId,
                row.JobId,
                row.Speakers,
                row.Progress,
                row.Status,
                row.ErrorCode,
                row.CreatedAt,
                row.CompletedAt);
    }

    /// <inheritdoc />
    public async ValueTask<bool> PointAtJobAsync(StartedItemTranscription transcription, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(transcription);

        var tenantId = Session.TenantId.Value;
        var now = clock.GetUtcNow();

        // One statement, so a first start and a restart are the same write. created_at is left
        // alone on conflict: it records when the item was first transcribed, and the current
        // job's own created_at is what a status read reports.
        try
        {
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"""
                INSERT INTO item_transcription
                    (audio_item_id, tenant_id, workspace_id, note_item_id, job_id, speakers, progress,
                     requested_by, created_at, updated_at)
                VALUES ({transcription.AudioItemId.Value}, {tenantId}, {transcription.WorkspaceId.Value},
                        {transcription.NoteItemId.Value}, {transcription.JobId.Value}, {transcription.Speakers}, 0,
                        {transcription.RequestedBy.Value}, {now}, {now})
                ON CONFLICT (audio_item_id) DO UPDATE
                    SET workspace_id = EXCLUDED.workspace_id,
                        note_item_id = EXCLUDED.note_item_id,
                        job_id = EXCLUDED.job_id,
                        speakers = EXCLUDED.speakers,
                        progress = 0,
                        requested_by = EXCLUDED.requested_by,
                        updated_at = EXCLUDED.updated_at
                    WHERE item_transcription.tenant_id = EXCLUDED.tenant_id
                """,
                cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.ForeignKeyViolation)
        {
            // The only foreign key on the table is the one to the audio item, so this is the item
            // having been purged after the caller read it. The statement has aborted the
            // transaction; the caller answers "not found" and the pipeline rolls back.
            return false;
        }
    }

    /// <inheritdoc />
    public async ValueTask ReportProgressAsync(ItemId audioItemId, WorkerJobId jobId, int percent, CancellationToken cancellationToken)
    {
        var tenantId = Session.TenantId;
        var progress = (short)Math.Clamp(percent, 0, 100);
        var now = clock.GetUtcNow();

        // Both conditions live in the predicate so the check and the write are one statement:
        // a row repointed at a newer job, or already further along, simply matches nothing.
        await database.ItemTranscriptions
            .Where(transcription => transcription.TenantId == tenantId
                && transcription.AudioItemId == audioItemId
                && transcription.JobId == jobId
                && transcription.Progress < progress)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(transcription => transcription.Progress, progress)
                    .SetProperty(transcription => transcription.UpdatedAt, now),
                cancellationToken).ConfigureAwait(false);
    }
}
