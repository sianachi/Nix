using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Abstractions.Transcriptions;

/// <summary>
/// Storage for the current transcription of an audio item (ADR-0059).
/// </summary>
/// <remarks>
/// <para>
/// A port for the reason <see cref="IItemTree"/> is one: the endpoints live in Features, which may
/// not name the database, and the implementation needs EF Core. There is one implementation and
/// no second is planned; the integration suite exercises it against real Postgres.
/// </para>
/// <para>
/// <b>Nothing here authorizes.</b> Every method is tenant-scoped by the session and by row-level
/// security, and takes the audio item as its key, but whether the caller may read that item or
/// write its note is decided by the endpoint before it calls in. That ordering is the contract:
/// <see cref="FindAsync"/> reports a job's status to somebody who did not start the job, which is
/// only correct because the caller has already been shown to be able to read the audio item.
/// </para>
/// </remarks>
public interface IItemTranscriptionStore
{
    /// <summary>
    /// Serializes starts for one audio item until the unit of work ends.
    /// </summary>
    /// <param name="audioItemId">The audio item.</param>
    /// <param name="cancellationToken">Cancels the wait.</param>
    /// <returns>A task that completes when this unit of work holds the item's start lock.</returns>
    /// <remarks>
    /// Two starts arriving together would otherwise both see no active job and each create one.
    /// The lock is transaction-scoped, so it needs no release and cannot outlive the request.
    /// </remarks>
    public ValueTask SerializeStartsAsync(ItemId audioItemId, CancellationToken cancellationToken);

    /// <summary>Reads an audio item's current transcription together with its job's state.</summary>
    /// <param name="audioItemId">The audio item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>
    /// The transcription, or <see langword="null"/> when none is recorded in this tenant or the
    /// job it names no longer exists.
    /// </returns>
    /// <remarks>
    /// The job is reached only through the transcription row, by the row's own job id and tenant.
    /// It is deliberately not filtered by the job's actor: a workspace member who can read the
    /// recording sees its transcription status whoever started it. The job's payload, result and
    /// error detail are not read.
    /// </remarks>
    public ValueTask<ItemTranscriptionRecord?> FindAsync(ItemId audioItemId, CancellationToken cancellationToken);

    /// <summary>Points an audio item's transcription at a newly created job, at progress zero.</summary>
    /// <param name="transcription">What was started.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when the audio item no longer exists - purged between the caller's
    /// read of it and this write. Nothing was written, and the unit of work can no longer commit:
    /// the caller answers "not found" and lets the pipeline roll back, which also discards the job
    /// it had just created.
    /// </returns>
    public ValueTask<bool> PointAtJobAsync(StartedItemTranscription transcription, CancellationToken cancellationToken);

    /// <summary>Raises the recorded progress, if <paramref name="jobId"/> is still the current job.</summary>
    /// <param name="audioItemId">The audio item.</param>
    /// <param name="jobId">The job reporting.</param>
    /// <param name="percent">The progress it reports, 0 to 100.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the report has been applied or ignored.</returns>
    /// <remarks>
    /// Monotonic, and silent about which happened: a superseded job and a report lower than the
    /// one already stored are both ignored, and neither is an error the worker could act on.
    /// </remarks>
    public ValueTask ReportProgressAsync(ItemId audioItemId, WorkerJobId jobId, int percent, CancellationToken cancellationToken);
}

/// <summary>An audio item's current transcription and the state of the job behind it.</summary>
/// <param name="AudioItemId">The audio file item.</param>
/// <param name="NoteItemId">The note the transcript is appended to.</param>
/// <param name="WorkspaceId">The workspace recorded when the job was started.</param>
/// <param name="JobId">The worker job.</param>
/// <param name="Speakers"><c>channels</c> or <c>none</c>.</param>
/// <param name="Progress">The last reported progress, 0 to 100.</param>
/// <param name="Status">The job's lifecycle state.</param>
/// <param name="ErrorCode">The job's stable failure code, when it has one.</param>
/// <param name="JobCreatedAt">When the current job was created.</param>
/// <param name="JobCompletedAt">When the current job reached a terminal state.</param>
public sealed record ItemTranscriptionRecord(
    ItemId AudioItemId,
    ItemId NoteItemId,
    WorkspaceId WorkspaceId,
    WorkerJobId JobId,
    string Speakers,
    int Progress,
    string Status,
    string? ErrorCode,
    DateTimeOffset JobCreatedAt,
    DateTimeOffset? JobCompletedAt);

/// <summary>A transcription that has just been given a job.</summary>
/// <param name="AudioItemId">The audio file item.</param>
/// <param name="WorkspaceId">The audio item's workspace.</param>
/// <param name="NoteItemId">The note the transcript is appended to.</param>
/// <param name="JobId">The job created for it.</param>
/// <param name="Speakers"><c>channels</c> or <c>none</c>.</param>
/// <param name="RequestedBy">Who started it.</param>
public sealed record StartedItemTranscription(
    ItemId AudioItemId,
    WorkspaceId WorkspaceId,
    ItemId NoteItemId,
    WorkerJobId JobId,
    string Speakers,
    PrincipalId RequestedBy);
