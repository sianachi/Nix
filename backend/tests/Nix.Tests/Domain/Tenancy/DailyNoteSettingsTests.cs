using Nix.Domain.Tenancy;
namespace Nix.Tests.Domain.Tenancy;

public sealed class DailyNoteSettingsTests
{
    [Fact]
    public void Defaults_preserve_personal_notes_and_require_shared_opt_in()
    {
        Assert.True(DailyNoteSettings.Default(true).Enabled);
        Assert.False(DailyNoteSettings.Default(false).Enabled);
    }
    [Theory]
    [InlineData("bad", "iso", 0)]
    [InlineData("flat", "bad", 0)]
    [InlineData("flat", "iso", -1)]
    [InlineData("flat", "iso", 7)]
    public void Invalid_settings_are_refused(string folders, string title, int hour)
    {
        Assert.True(DailyNoteSettings.Create(true, folders, title, null, hour, false).IsFailure);
    }
    [Fact]
    public void Settings_round_trip_and_shape_only_new_notes()
    {
        var settings = DailyNoteSettings.Create(true, "by-month", "weekday-long", "# Start", 3, true).Value;
        Assert.Equal(settings, DailyNoteSettings.Read(settings.Write(), false));
        Assert.Collection(settings.FolderKeys(new DateOnly(2026, 10, 4)),
            year => Assert.Equal("2026", year), month => Assert.Equal("2026-10", month));
        Assert.Equal("Sunday 4 October 2026", settings.FormatTitle(new DateOnly(2026, 10, 4)));
        Assert.True(DailyNoteSettings.Create(true, "flat", "iso", new string('a', 4001), 0, false).IsFailure);
    }
    [Fact]
    public void Malformed_stored_settings_fall_back_field_by_field()
    {
        Assert.Equal(DailyNoteSettings.Default(false), DailyNoteSettings.Read("broken", false));
        var read = DailyNoteSettings.Read("""{"enabled":true,"folders":"bad","rolloverHour":99} """, false);
        Assert.True(read.Enabled);
        Assert.Equal(DailyNoteFolders.Flat, read.Folders);
        Assert.Equal(0, read.RolloverHour);
    }
}
