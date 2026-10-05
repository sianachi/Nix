using System.Text.Json.Nodes;
using Nix.Domain.Habits;

namespace Nix.Tests.Domain.Habits;

public sealed class HabitHistoryTests
{
    private static readonly HabitSettings Original = new("daily", [], "UTC", new DateOnly(2026, 9, 1), 20, "minutes");

    private static JsonObject Apply(JsonObject original, JsonObject changes)
    {
        var copy = original.DeepClone().AsObject();
        foreach (var (key, value) in changes)
        {
            copy[key] = value?.DeepClone();
        }
        return copy;
    }

    [Fact]
    public void Repeated_edits_keep_every_previous_date_and_target()
    {
        var properties = Original.ToProperties();
        foreach (var (day, target) in new[] { (10, 30), (12, 40), (12, 50) })
        {
            var history = HabitHistory.Read(properties.ToJsonString())!;
            properties = Apply(properties, history.ChangeSettings(Original with { Target = target }, new DateOnly(2026, 9, day))!);
        }
        var saved = HabitHistory.Read(properties.ToJsonString())!;
        Assert.Equal(20, saved.SettingsOn(new DateOnly(2026, 9, 9)).Target);
        Assert.Equal(30, saved.SettingsOn(new DateOnly(2026, 9, 10)).Target);
        Assert.Equal(30, saved.SettingsOn(new DateOnly(2026, 9, 11)).Target);
        Assert.Equal(50, saved.SettingsOn(new DateOnly(2026, 9, 12)).Target);
    }

    [Fact]
    public void Pause_resume_and_archive_preserve_prior_intervals()
    {
        var properties = Original.ToProperties();
        foreach (var (day, status) in new[] { (10, "paused"), (12, "active"), (14, "archived"), (15, "active") })
        {
            var history = HabitHistory.Read(properties.ToJsonString())!;
            properties = Apply(properties, history.ChangeStatus(status, new DateOnly(2026, 9, day))!);
        }
        var saved = HabitHistory.Read(properties.ToJsonString())!;
        Assert.Equal("active", saved.StatusOn(new DateOnly(2026, 9, 9)));
        Assert.Equal("paused", saved.StatusOn(new DateOnly(2026, 9, 11)));
        Assert.Equal("active", saved.StatusOn(new DateOnly(2026, 9, 13)));
        Assert.Equal("archived", saved.StatusOn(new DateOnly(2026, 9, 14)));
        Assert.Equal("active", saved.StatusOn(new DateOnly(2026, 9, 15)));
    }

    [Fact]
    public void Same_day_resume_does_not_rewrite_earlier_pauses()
    {
        var properties = Original.ToProperties();
        foreach (var (day, status) in new[] { (10, "paused"), (12, "active"), (12, "paused"), (12, "active") })
        {
            properties = Apply(properties, HabitHistory.Read(properties.ToJsonString())!.ChangeStatus(status, new DateOnly(2026, 9, day))!);
        }
        var saved = HabitHistory.Read(properties.ToJsonString())!;
        Assert.Equal("paused", saved.StatusOn(new DateOnly(2026, 9, 11)));
        Assert.Equal("active", saved.StatusOn(new DateOnly(2026, 9, 12)));
    }

    [Fact]
    public void Malformed_history_does_not_silently_recalculate_old_progress()
    {
        var properties = Original.ToProperties();
        properties["$habit_versions"] = new JsonArray(new JsonObject { ["effectiveFrom"] = "bad" });
        Assert.Null(HabitHistory.Read(properties.ToJsonString()));
    }
}
