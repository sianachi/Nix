namespace Nix.Domain.Transcriptions;

/// <summary>The worker job that transcribes one audio item (ADR-0059).</summary>
/// <remarks>
/// Spelled once. The endpoints create and recognise jobs by this kind, and the store reads a job's
/// state through a transcription row only when the job is of this kind; two spellings would let
/// one of them drift and quietly stop matching.
/// </remarks>
public static class TranscriptionJob
{
    /// <summary>The job kind. The <c>transcribe.</c> prefix is what routes it to the speech queue.</summary>
    public const string Kind = "transcribe.audio";
}
