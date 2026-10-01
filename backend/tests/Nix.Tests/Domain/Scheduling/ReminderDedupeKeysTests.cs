using Nix.Domain.Scheduling;

namespace Nix.Tests.Domain.Scheduling;

/// <summary>
/// Dedupe keys the three reminder sources build - from identifiers alone, per ADR-0051
/// Amendment 1's rule that a dedupe key never carries user-written text.
/// </summary>
public sealed class ReminderDedupeKeysTests
{
    private static readonly Guid ItemId = Guid.Parse("11111111-2222-4333-8444-555555555555");

    [Fact]
    public void An_explicit_reminder_key_names_the_item_and_the_exact_instant()
    {
        var instant = new DateTimeOffset(2026, 3, 17, 9, 0, 0, TimeSpan.Zero);

        var key = ReminderDedupeKeys.Explicit(ItemId, instant);

        Assert.StartsWith($"reminder:{ItemId:D}:", key, StringComparison.Ordinal);
        Assert.Equal(key, ReminderDedupeKeys.Explicit(ItemId, instant));
    }

    [Fact]
    public void An_explicit_reminder_key_changes_when_the_instant_changes()
    {
        var first = ReminderDedupeKeys.Explicit(ItemId, new DateTimeOffset(2026, 3, 17, 9, 0, 0, TimeSpan.Zero));
        var second = ReminderDedupeKeys.Explicit(ItemId, new DateTimeOffset(2026, 3, 17, 9, 0, 1, TimeSpan.Zero));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void A_due_reminder_key_names_the_item_and_the_local_occurrence_day()
    {
        var key = ReminderDedupeKeys.Due(ItemId, new DateOnly(2026, 3, 17));

        Assert.Equal($"due:{ItemId:D}:2026-03-17", key);
    }

    [Fact]
    public void A_habit_reminder_key_names_the_item_and_the_local_scheduled_day()
    {
        var key = ReminderDedupeKeys.Habit(ItemId, new DateOnly(2026, 3, 17));

        Assert.Equal($"habit:{ItemId:D}:2026-03-17", key);
    }

    [Fact]
    public void The_three_kinds_never_collide_on_the_same_item_and_day()
    {
        var day = new DateOnly(2026, 3, 17);
        var due = ReminderDedupeKeys.Due(ItemId, day);
        var habit = ReminderDedupeKeys.Habit(ItemId, day);
        var explicitKey = ReminderDedupeKeys.Explicit(ItemId, new DateTimeOffset(day.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero));

        Assert.NotEqual(due, habit);
        Assert.NotEqual(due, explicitKey);
        Assert.NotEqual(habit, explicitKey);
    }
}
