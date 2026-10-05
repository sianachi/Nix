using Nix.Domain.Scheduling;

namespace Nix.Tests.Domain.Scheduling;

/// <summary>Deferring a computed fire instant out of a principal's quiet hours, in their own zone.</summary>
public sealed class ReminderQuietHoursTests
{
    [Fact]
    public void A_fire_instant_outside_quiet_hours_is_unchanged()
    {
        // 14:00 UTC in a zone with no offset (Etc/UTC), quiet hours 22:00-07:00: nowhere near.
        var fireAt = new DateTimeOffset(2026, 6, 15, 14, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Etc/UTC", new TimeOnly(22, 0), new TimeOnly(7, 0));

        Assert.Equal(fireAt, result);
    }

    [Fact]
    public void No_quiet_hours_configured_leaves_the_instant_unchanged()
    {
        var fireAt = new DateTimeOffset(2026, 6, 15, 23, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Etc/UTC", null, null);

        Assert.Equal(fireAt, result);
    }

    [Fact]
    public void A_fire_instant_before_midnight_inside_a_crossing_window_defers_to_quiet_end_the_next_day()
    {
        // 23:00 UTC, quiet hours 22:00-07:00 (crosses midnight): inside, on the "before midnight"
        // side, so it defers to 07:00 the *next* local day.
        var fireAt = new DateTimeOffset(2026, 6, 15, 23, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Etc/UTC", new TimeOnly(22, 0), new TimeOnly(7, 0));

        Assert.Equal(new DateTimeOffset(2026, 6, 16, 7, 0, 0, TimeSpan.Zero), result);
    }

    [Fact]
    public void A_fire_instant_after_midnight_inside_a_crossing_window_defers_to_quiet_end_the_same_day()
    {
        // 02:00 UTC, quiet hours 22:00-07:00 (crosses midnight): inside, already past midnight, so
        // it defers to 07:00 the *same* local day rather than a day forward.
        var fireAt = new DateTimeOffset(2026, 6, 16, 2, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Etc/UTC", new TimeOnly(22, 0), new TimeOnly(7, 0));

        Assert.Equal(new DateTimeOffset(2026, 6, 16, 7, 0, 0, TimeSpan.Zero), result);
    }

    [Fact]
    public void A_fire_instant_inside_a_non_crossing_window_defers_within_the_same_day()
    {
        // A window that does not cross midnight, e.g. 12:00-13:00 (an unusual but valid "quiet at
        // lunch" configuration): 12:30 is inside, and the whole window sits inside one local day.
        var fireAt = new DateTimeOffset(2026, 6, 15, 12, 30, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Etc/UTC", new TimeOnly(12, 0), new TimeOnly(13, 0));

        Assert.Equal(new DateTimeOffset(2026, 6, 15, 13, 0, 0, TimeSpan.Zero), result);
    }

    [Fact]
    public void The_zone_the_quiet_hours_are_read_in_can_shift_which_side_of_midnight_a_moment_falls_on()
    {
        // 23:00 UTC is 06:00 the next day in Asia/Tokyo (UTC+9) - well outside a 22:00-07:00 quiet
        // window read in Tokyo's own local time, even though the same instant would have been
        // inside the window if read in UTC.
        var fireAt = new DateTimeOffset(2026, 6, 15, 23, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "Asia/Tokyo", new TimeOnly(22, 0), new TimeOnly(7, 0));

        Assert.Equal(fireAt, result);
    }

    [Fact]
    public void A_deferral_across_a_daylight_saving_transition_still_lands_at_the_configured_local_time()
    {
        // America/New_York falls back an hour at 2026-11-01 02:00 local (clocks go from 02:00 to
        // 01:00). 2026-11-01T03:00:00Z is 2026-10-31T23:00 local, EDT (-04:00), still inside a
        // 22:00-07:00 quiet window - just before the transition. It defers to 07:00 local on
        // 2026-11-01 - the day of the transition itself - and the result must still read as 07:00
        // once the transition has already happened (EST, -05:00), not 07:00 clock-shifted by it.
        var fireAt = new DateTimeOffset(2026, 11, 1, 3, 0, 0, TimeSpan.Zero);

        var result = ReminderQuietHours.Apply(fireAt, "America/New_York", new TimeOnly(22, 0), new TimeOnly(7, 0));

        var zone = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        var resultLocal = TimeZoneInfo.ConvertTime(result, zone);
        Assert.Equal(new DateTime(2026, 11, 1, 7, 0, 0), resultLocal.DateTime);
    }
}
