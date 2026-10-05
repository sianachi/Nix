using Nix.Abstractions.Transcriptions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Features.Transcriptions;

namespace Nix.Tests.Features.Transcriptions;

/// <summary>
/// What a transcription request may say, and how a stored transcription is reported.
/// </summary>
public sealed class TranscriptionRulesTests
{
    [Theory]
    [InlineData("channels", true)]
    [InlineData("none", true)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("Channels", false)]
    [InlineData(" none", false)]
    [InlineData("diarize", false)]
    public void Only_the_two_speaker_modes_are_accepted_exactly(string? speakers, bool expected) =>
        Assert.Equal(expected, TranscriptionRules.ValidSpeakers(speakers));

    [Theory]
    [InlineData(0, true)]
    [InlineData(100, true)]
    [InlineData(57, true)]
    [InlineData(-1, false)]
    [InlineData(101, false)]
    [InlineData(int.MaxValue, false)]
    public void A_percentage_is_between_zero_and_a_hundred(int percent, bool expected) =>
        Assert.Equal(expected, TranscriptionRules.ValidPercent(percent));

    [Theory]
    [InlineData("queued", true)]
    [InlineData("running", true)]
    [InlineData("completed", false)]
    [InlineData("failed", false)]
    [InlineData("cancelled", false)]
    public void Only_a_queued_or_running_job_blocks_a_new_start(string status, bool expected) =>
        Assert.Equal(expected, TranscriptionRules.Active(status));

    [Fact]
    public void A_short_title_is_left_alone() =>
        Assert.Equal("Standup", TranscriptionRules.BoundTitle("Standup"));

    [Fact]
    public void A_long_title_is_cut_to_the_limit()
    {
        var bounded = TranscriptionRules.BoundTitle(new string('x', 900));

        Assert.Equal(TranscriptionRules.MaximumAudioTitleLength, bounded.Length);
    }

    [Fact]
    public void A_cut_never_splits_a_surrogate_pair()
    {
        // The pair straddles the limit: its high half would be the last unit kept.
        var title = new string('x', TranscriptionRules.MaximumAudioTitleLength - 1) + "\U0001F399" + "tail";

        var bounded = TranscriptionRules.BoundTitle(title);

        Assert.Equal(TranscriptionRules.MaximumAudioTitleLength - 1, bounded.Length);
        Assert.False(char.IsHighSurrogate(bounded[^1]));
    }

    [Theory]
    [InlineData("Standup", "standup.weba", "Standup")]
    [InlineData("  Standup  ", "standup.weba", "Standup")]
    [InlineData("", "standup.weba", "standup.weba")]
    [InlineData("   ", "standup.weba", "standup.weba")]
    [InlineData(null, "standup.weba", "standup.weba")]
    [InlineData("", "", "Recording")]
    [InlineData(null, null, "Recording")]
    [InlineData(" ", " ", "Recording")]
    public void The_section_label_is_the_title_then_the_file_name_and_never_empty(
        string? title,
        string? fileName,
        string expected) =>
        Assert.Equal(expected, TranscriptionRules.AudioTitle(title, fileName));

    [Fact]
    public void A_long_file_name_used_as_the_label_is_bounded_too()
    {
        var label = TranscriptionRules.AudioTitle(string.Empty, new string('f', 700) + ".mp3");

        Assert.Equal(TranscriptionRules.MaximumAudioTitleLength, label.Length);
    }

    [Fact]
    public void A_running_transcription_reports_the_progress_recorded()
    {
        var response = TranscriptionRules.ToResponse(Record("running", progress: 42));

        Assert.Equal("running", response.Status);
        Assert.Equal(42, response.Progress);
        Assert.Null(response.CompletedAt);
        Assert.Null(response.ErrorCode);
    }

    [Fact]
    public void A_completed_transcription_reports_a_hundred_whatever_was_last_recorded()
    {
        var completedAt = DateTimeOffset.UtcNow;

        var response = TranscriptionRules.ToResponse(Record("completed", progress: 97, completedAt: completedAt));

        Assert.Equal(100, response.Progress);
        Assert.Equal(completedAt, response.CompletedAt);
    }

    [Fact]
    public void A_failed_transcription_keeps_its_progress_and_carries_only_the_error_code()
    {
        var record = Record("failed", progress: 30, completedAt: DateTimeOffset.UtcNow) with
        {
            ErrorCode = "transcription_decode_failed",
        };

        var response = TranscriptionRules.ToResponse(record);

        Assert.Equal(30, response.Progress);
        Assert.Equal("transcription_decode_failed", response.ErrorCode);
        Assert.Equal(record.JobId.Value, response.OperationId);
        Assert.Equal(record.AudioItemId.Value, response.AudioItemId);
        Assert.Equal(record.NoteItemId.Value, response.NoteItemId);
        Assert.Equal(record.JobCreatedAt, response.CreatedAt);
    }

    private static ItemTranscriptionRecord Record(
        string status,
        int progress,
        DateTimeOffset? completedAt = null) => new(
            AudioItemId: ItemId.From(Guid.NewGuid()),
            NoteItemId: ItemId.From(Guid.NewGuid()),
            WorkspaceId: WorkspaceId.From(Guid.NewGuid()),
            JobId: WorkerJobId.From(Guid.NewGuid()),
            Speakers: "none",
            Progress: progress,
            Status: status,
            ErrorCode: null,
            JobCreatedAt: DateTimeOffset.UtcNow.AddMinutes(-3),
            JobCompletedAt: completedAt);
}
