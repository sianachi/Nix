namespace Nix.Features.Transcriptions;

/// <summary>
/// Why a worker route refused, for the operator. The worker is told one thing - 404 - whatever
/// the cause; without these lines a transcription that fails at the source or the append would
/// leave nothing to say which of a dozen conditions it met.
/// </summary>
/// <remarks>
/// Identifiers only. A recording's title and file name are content, and the second is withheld by
/// a lock; neither is ever a log field.
/// </remarks>
internal static partial class TranscriptionLog
{
    /// <summary>The logger category every worker-route line is written under.</summary>
    internal const string Category = "Nix.Features.Transcriptions.Worker";

    [LoggerMessage(5500, LogLevel.Information, "Transcription {route} refused for job {jobId} in tenant {tenantId}: {reason}")]
    public static partial void Refused(ILogger logger, string route, Guid jobId, Guid tenantId, string reason);

    // Error, not Information: Core wrote this payload itself, so one it cannot read back is a bug
    // in Core or a row altered behind it, never something a worker or a user did.
    [LoggerMessage(5501, LogLevel.Error, "Transcription job {jobId} in tenant {tenantId} carries a payload Core cannot read back")]
    public static partial void PayloadUnreadable(ILogger logger, Guid jobId, Guid tenantId, Exception? exception);
}
