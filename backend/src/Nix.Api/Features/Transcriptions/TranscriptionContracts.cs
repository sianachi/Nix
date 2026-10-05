using System.Text.Json.Serialization;
using Nix.Abstractions.Transcriptions;

namespace Nix.Features.Transcriptions;

/// <summary>Asks for an audio item to be transcribed into its parent note.</summary>
/// <param name="Speakers">
/// <c>channels</c> when the recording carries the microphone and the shared audio on separate
/// stereo channels, so the transcript can say "me" and "others"; <c>none</c> for anything else.
/// </param>
public sealed record StartTranscriptionRequest(string? Speakers);

/// <summary>The current transcription of an audio item.</summary>
/// <param name="AudioItemId">The audio file item.</param>
/// <param name="NoteItemId">The note the transcript is appended to.</param>
/// <param name="Status"><c>queued</c>, <c>running</c>, <c>completed</c>, <c>failed</c> or <c>cancelled</c>.</param>
/// <param name="Progress">A whole percentage, 0 to 100. Always 100 once completed.</param>
/// <param name="Speakers"><c>channels</c> or <c>none</c>.</param>
/// <param name="OperationId">The worker job behind it.</param>
/// <param name="ErrorCode">A stable failure code, when the job has one.</param>
/// <param name="CreatedAt">When the current job was created.</param>
/// <param name="CompletedAt">When the current job reached a terminal state.</param>
public sealed record TranscriptionResponse(
    Guid AudioItemId,
    Guid NoteItemId,
    string Status,
    int Progress,
    string Speakers,
    Guid OperationId,
    string? ErrorCode,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

/// <summary>The durable request a <c>transcribe.audio</c> job carries.</summary>
/// <param name="AudioItemId">The audio file item.</param>
/// <param name="NoteItemId">The note the transcript is appended to.</param>
/// <param name="Speakers"><c>channels</c> or <c>none</c>.</param>
public sealed record TranscriptionJobPayload(Guid AudioItemId, Guid NoteItemId, string Speakers);

/// <summary>Where a leased transcription's audio is, and what the job is for.</summary>
/// <param name="SourceUrl">A short-lived capability to read the audio bytes from object storage.</param>
/// <param name="ByteLength">The stored length of the audio.</param>
/// <param name="AudioItemId">The audio file item.</param>
/// <param name="NoteItemId">The note the transcript is appended to.</param>
/// <param name="WorkspaceId">The workspace both live in.</param>
/// <param name="Speakers"><c>channels</c> or <c>none</c>.</param>
public sealed record WorkerTranscriptionSourceResponse(
    Uri SourceUrl,
    long ByteLength,
    Guid AudioItemId,
    Guid NoteItemId,
    Guid WorkspaceId,
    string Speakers);

/// <summary>A leased transcription's progress report.</summary>
/// <param name="Percent">A whole percentage, 0 to 100.</param>
public sealed record WorkerTranscriptionProgressRequest(int Percent);

/// <summary>
/// What the collaboration service is told before it appends a transcript: whose write it is and
/// which note it goes to.
/// </summary>
/// <param name="TenantId">The tenant the job runs in.</param>
/// <param name="PrincipalId">The job's actor, as whom the note is written.</param>
/// <param name="WorkspaceId">The workspace the note lives in.</param>
/// <param name="NoteItemId">The note to append to.</param>
/// <param name="AudioItemId">The recording the transcript is of.</param>
/// <param name="AudioTitle">The recording's title, at most 500 characters, to label the section.</param>
/// <param name="CanWrite">
/// Always <see langword="true"/> on a 200: a note the actor may not write is answered 404, never
/// described. Carried anyway so the contract states the fact instead of implying it.
/// </param>
public sealed record WorkerTranscriptionAuthorizationResponse(
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    Guid NoteItemId,
    Guid AudioItemId,
    string AudioTitle,
    bool CanWrite);

/// <summary>The few rules a transcription request and its job share.</summary>
public static class TranscriptionRules
{
    /// <summary>Separate stereo channels tell the speakers apart.</summary>
    public const string SpeakersByChannel = "channels";

    /// <summary>Nothing tells the speakers apart.</summary>
    public const string SpeakersUnknown = "none";

    /// <summary>The longest recording title handed to the collaboration service.</summary>
    public const int MaximumAudioTitleLength = 500;

    /// <summary>
    /// Whether <paramref name="speakers"/> is one of the two modes the worker understands.
    /// </summary>
    /// <remarks>
    /// Exact and case-sensitive: the value is written into a job payload and a constrained column
    /// unchanged, so there is no tolerant spelling to normalise to.
    /// </remarks>
    public static bool ValidSpeakers(string? speakers) =>
        speakers is SpeakersByChannel or SpeakersUnknown;

    /// <summary>Whether a reported percentage is one.</summary>
    public static bool ValidPercent(int percent) => percent is >= 0 and <= 100;

    /// <summary>Whether a job may still be making progress.</summary>
    public static bool Active(string status) => status is "queued" or "running";

    /// <summary>
    /// Cuts a title to <see cref="MaximumAudioTitleLength"/> UTF-16 units without splitting a
    /// surrogate pair, which would hand the collaboration service a string that is not text.
    /// </summary>
    public static string BoundTitle(string title)
    {
        ArgumentNullException.ThrowIfNull(title);

        if (title.Length <= MaximumAudioTitleLength)
        {
            return title;
        }

        var length = char.IsHighSurrogate(title[MaximumAudioTitleLength - 1])
            ? MaximumAudioTitleLength - 1
            : MaximumAudioTitleLength;
        return title[..length];
    }

    /// <summary>What the collaboration service calls a recording whose title and file name are both blank.</summary>
    public const string UntitledAudio = "Recording";

    /// <summary>
    /// The label the transcript section carries: the recording's title, else its file name, else
    /// <see cref="UntitledAudio"/>, bounded by <see cref="BoundTitle"/>.
    /// </summary>
    /// <remarks>
    /// Never empty. The collaboration service writes it into a sentence ("From ..., 12:04 long."),
    /// and an untitled upload would otherwise leave a hole in the note.
    /// </remarks>
    public static string AudioTitle(string? title, string? fileName)
    {
        var label = title?.Trim();
        if (string.IsNullOrEmpty(label))
        {
            label = fileName?.Trim();
        }

        return string.IsNullOrEmpty(label) ? UntitledAudio : BoundTitle(label);
    }

    /// <summary>Maps the stored transcription to its public shape.</summary>
    /// <remarks>
    /// A completed job reports 100 whatever the last progress report said: the worker's final
    /// report and its completion are separate calls, and a bar stuck at 97 beside "completed" is
    /// a contradiction the client should never have to reconcile.
    /// </remarks>
    public static TranscriptionResponse ToResponse(ItemTranscriptionRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        return new TranscriptionResponse(
            record.AudioItemId.Value,
            record.NoteItemId.Value,
            record.Status,
            record.Status == "completed" ? 100 : Math.Clamp(record.Progress, 0, 100),
            record.Speakers,
            record.JobId.Value,
            record.ErrorCode,
            record.JobCreatedAt,
            record.JobCompletedAt);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(StartTranscriptionRequest))]
[JsonSerializable(typeof(TranscriptionResponse))]
[JsonSerializable(typeof(TranscriptionJobPayload))]
[JsonSerializable(typeof(WorkerTranscriptionSourceResponse))]
[JsonSerializable(typeof(WorkerTranscriptionProgressRequest))]
[JsonSerializable(typeof(WorkerTranscriptionAuthorizationResponse))]
internal sealed partial class TranscriptionsJsonContext : JsonSerializerContext;
