using Nix.Domain.Habits;

namespace Nix.Tests.Domain.Habits;

public sealed class HabitSettingsTests
{
    [Fact]
    public void Local_today_respects_saved_timezone_across_midnight()
    {
        var settings = new HabitSettings("daily", [], "America/Los_Angeles", new DateOnly(2026, 1, 1), 1, "times");
        var instant = new DateTimeOffset(2026, 9, 14, 1, 0, 0, TimeSpan.Zero);
        Assert.Equal(new DateOnly(2026, 9, 13), settings.Today(instant));
        Assert.Equal(new DateOnly(2026, 9, 14), (settings with { Timezone = "Asia/Tokyo" }).Today(instant));
    }

    [Fact]
    public void Selected_weekdays_and_start_date_both_constrain_planned_days()
    {
        var settings = new HabitSettings("weekly", [1, 3, 5], "UTC", new DateOnly(2026, 9, 14), 20, "minutes");
        Assert.False(settings.IsScheduled(new DateOnly(2026, 9, 11)));
        Assert.True(settings.IsScheduled(new DateOnly(2026, 9, 14)));
        Assert.False(settings.IsScheduled(new DateOnly(2026, 9, 15)));
        Assert.True(settings.IsScheduled(new DateOnly(2026, 9, 16)));
        Assert.NotNull((settings with { Weekdays = [1, 1] }).Validate());
        Assert.NotNull((settings with { Weekdays = [] }).Validate());
        Assert.NotNull((settings with { Frequency = "daily" }).Validate());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("{\"$habit_frequency\":false}")]
    [InlineData("not json")]
    public void Malformed_settings_are_not_treated_as_a_valid_empty_habit(string json)
    {
        Assert.Null(HabitSettings.Read(json));
    }

    [Fact]
    public void Settings_round_trip_and_weekday_order_does_not_change_the_schedule()
    {
        var settings = new HabitSettings("weekly", [5, 1], "Europe/London", new DateOnly(2026, 9, 14), 0.5m, "hours");
        var stored = HabitSettings.Read(settings.ToProperties().ToJsonString());
        Assert.NotNull(stored);
        Assert.True(settings.SameSchedule(stored));
        Assert.True(settings.SameSchedule(settings with { Weekdays = [1, 5] }));
        Assert.False(settings.SameSchedule(settings with { Target = 1 }));
    }
}
