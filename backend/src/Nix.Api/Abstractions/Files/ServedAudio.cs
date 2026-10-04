namespace Nix.Abstractions.Files;

/// <summary>
/// The audio types a file may be served as inline.
/// </summary>
/// <remarks>
/// Audio is not "previewable" in the image sense: no pixels, no size ceiling. It is streamed to a
/// media element, which cannot render markup, and every capability response carries
/// <c>nosniff</c>, so a vetted audio type is safe to serve inline where an arbitrary one is not.
/// </remarks>
public static class ServedAudio
{
    private static readonly HashSet<string> MediaTypes =
        ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/ogg", "audio/flac", "audio/webm"];

    /// <summary>Whether a stored media type is one of the audio types served inline.</summary>
    public static bool IsServed(string mediaType) => MediaTypes.Contains(mediaType);

    /// <summary>The audio type for a file whose stored type is generic, from its extension.</summary>
    public static string? ForExtension(string fileName) =>
        Path.GetExtension(fileName).ToUpperInvariant() switch
        {
            ".MP3" => "audio/mpeg",
            ".M4A" => "audio/mp4",
            ".AAC" => "audio/aac",
            ".WAV" => "audio/wav",
            ".OGG" or ".OGA" or ".OPUS" => "audio/ogg",
            ".FLAC" => "audio/flac",
            ".WEBA" => "audio/webm",
            _ => null,
        };
}
