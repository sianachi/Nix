using Nix.Abstractions.Files;
namespace Nix.Tests.Domain.Files;

public sealed class ServedAudioTests
{
    [Theory]
    [InlineData("recording.MP3", "audio/mpeg")]
    [InlineData("book.m4a", "audio/mp4")]
    [InlineData("voice.opus", "audio/ogg")]
    [InlineData("voice.flac", "audio/flac")]
    public void Audio_extension_resolves_to_a_closed_inline_type(string file, string mediaType)
    {
        Assert.Equal(mediaType, ServedAudio.ForExtension(file));
        Assert.True(ServedAudio.IsServed(mediaType));
    }
    [Theory]
    [InlineData("text/html")]
    [InlineData("image/svg+xml")]
    [InlineData("application/octet-stream")]
    public void Active_and_generic_types_are_never_audio(string mediaType)
    {
        Assert.False(ServedAudio.IsServed(mediaType));
        Assert.Null(ServedAudio.ForExtension("file.html"));
    }
}
