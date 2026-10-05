using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Domain.Transcriptions;

/// <summary>
/// The current transcription of one audio item (ADR-0059): which job is transcribing it, into
/// which note, and how far along it is.
/// </summary>
/// <remarks>
/// <para>
/// <b>One row per audio item, and it names the current job only.</b> Starting again after a
/// failure repoints the row at the new job; the earlier job stays in <c>worker_job</c> as its own
/// record. That is what lets a progress report be checked against the row: a job the row no
/// longer names has been superseded and must not move the bar.
/// </para>
/// <para>
/// <b>Status is not stored here.</b> It is the job's, read through the row. A copy would be a
/// second answer to "is it finished" that the dispatcher's terminal write would have to keep in
/// step. Progress is the one fact the job row has no column for, which is why this table exists.
/// </para>
/// </remarks>
public sealed class ItemTranscription
{
    /// <summary>Gets the audio file item being transcribed.</summary>
    public required ItemId AudioItemId { get; init; }

    /// <summary>Gets the tenant the item belongs to.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace the audio item was in when the transcription was started.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the note the transcript is appended to: the audio item's parent at start.</summary>
    public required ItemId NoteItemId { get; init; }

    /// <summary>Gets the worker job currently transcribing the item.</summary>
    public required WorkerJobId JobId { get; init; }

    /// <summary>Gets how speakers are told apart: <c>channels</c> or <c>none</c>.</summary>
    public required string Speakers { get; init; }

    /// <summary>Gets the last progress the current job reported, 0 to 100.</summary>
    public required short Progress { get; init; }

    /// <summary>Gets the principal who started the current job.</summary>
    public required PrincipalId RequestedBy { get; init; }

    /// <summary>Gets when the item was first transcribed.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when the row last changed: a new job, or a progress report.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
