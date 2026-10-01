using Nix.Domain.Calendar;

namespace Nix.Tests.Domain.Calendar;

/// <summary>
/// The pure decisions calendar sync makes (ADR-0052, Amendment 1): who wins a conflict, what the
/// sync hash covers, how provider text is cleaned, the pull window and its re-baseline, and the
/// planned slot, stagger and trigger keys.
/// </summary>
public sealed class CalendarSyncRulesTests
{
    private static readonly DateTimeOffset ItemUpdated = new(2026, 9, 30, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    // readOnly: the provider always wins, whatever else is true.
    [InlineData(true, true, 1, CalendarSyncWinner.Provider)]
    [InlineData(true, true, -1, CalendarSyncWinner.Provider)]
    [InlineData(true, false, -1, CalendarSyncWinner.Provider)]
    // Nix unchanged: the provider's change is simply applied.
    [InlineData(false, false, 1, CalendarSyncWinner.Provider)]
    [InlineData(false, false, -1, CalendarSyncWinner.Provider)]
    [InlineData(false, false, 0, CalendarSyncWinner.Provider)]
    // Both changed: the later modification wins; a tie keeps the Nix edit.
    [InlineData(false, true, 1, CalendarSyncWinner.Provider)]
    [InlineData(false, true, -1, CalendarSyncWinner.Nix)]
    [InlineData(false, true, 0, CalendarSyncWinner.Nix)]
    public void The_conflict_table_is_readonly_then_unchanged_then_later_modification(
        bool readOnly, bool nixChanged, int providerOffsetMinutes, CalendarSyncWinner expected)
    {
        var providerUpdated = ItemUpdated.AddMinutes(providerOffsetMinutes);
        Assert.Equal(expected, CalendarSyncRules.Decide(readOnly, nixChanged, providerUpdated, ItemUpdated));
    }

    [Fact]
    public void The_hash_is_stable_and_covers_every_synced_field()
    {
        var baseline = CalendarSyncRules.Hash("Standup", "2026-10-01", "2026-10-02", "Room 4", "Notes");
        Assert.Equal(32, baseline.Length);
        Assert.Equal(baseline, CalendarSyncRules.Hash("Standup", "2026-10-01", "2026-10-02", "Room 4", "Notes"));

        Assert.NotEqual(baseline, CalendarSyncRules.Hash("Standup!", "2026-10-01", "2026-10-02", "Room 4", "Notes"));
        Assert.NotEqual(baseline, CalendarSyncRules.Hash("Standup", "2026-10-02", "2026-10-02", "Room 4", "Notes"));
        Assert.NotEqual(baseline, CalendarSyncRules.Hash("Standup", "2026-10-01", null, "Room 4", "Notes"));
        Assert.NotEqual(baseline, CalendarSyncRules.Hash("Standup", "2026-10-01", "2026-10-02", "Room 5", "Notes"));
        Assert.NotEqual(baseline, CalendarSyncRules.Hash("Standup", "2026-10-01", "2026-10-02", "Room 4", "Notes."));

        // Field boundaries are part of what is hashed, so text cannot move between fields unseen.
        Assert.NotEqual(
            CalendarSyncRules.Hash("ab", "2026-10-01", null, "c", string.Empty),
            CalendarSyncRules.Hash("a", "2026-10-01", null, "bc", string.Empty));
    }

    [Fact]
    public void Sanitizing_keeps_newlines_and_tabs_and_drops_every_other_control_character()
    {
        Assert.Equal("a\nb\tc", CalendarSyncRules.Sanitize("a\nb\tc"));
        Assert.Equal("abc", CalendarSyncRules.Sanitize("a\u0000b\u001bc\u007f"));
        Assert.Equal("line", CalendarSyncRules.Sanitize("line\r"));
        Assert.Equal(string.Empty, CalendarSyncRules.Sanitize(null));
    }

    [Fact]
    public void The_window_runs_from_midnight_past_days_ago_to_midnight_after_future_days()
    {
        var now = new DateTimeOffset(2026, 9, 30, 15, 42, 7, TimeSpan.Zero);
        var (start, end) = CalendarSyncRules.Window(now, 30, 365);
        Assert.Equal(new DateTimeOffset(2026, 8, 31, 0, 0, 0, TimeSpan.Zero), start);
        Assert.Equal(new DateTimeOffset(2027, 10, 1, 0, 0, 0, TimeSpan.Zero), end);
    }

    [Fact]
    public void The_cursor_is_dropped_for_a_full_request_a_missing_cursor_a_monthly_rebaseline_or_new_window_days()
    {
        var start = new DateTimeOffset(2026, 8, 31, 0, 0, 0, TimeSpan.Zero);
        var end = new DateTimeOffset(2027, 10, 1, 0, 0, 0, TimeSpan.Zero);

        Assert.False(CalendarSyncRules.RequiresFullResync(false, "cursor", start, end, start, end));
        Assert.True(CalendarSyncRules.RequiresFullResync(true, "cursor", start, end, start, end));
        Assert.True(CalendarSyncRules.RequiresFullResync(false, null, start, end, start, end));
        Assert.True(CalendarSyncRules.RequiresFullResync(false, "cursor", null, null, start, end));

        // The window slides a day at a time; within 31 days the cursor survives.
        Assert.False(CalendarSyncRules.RequiresFullResync(false, "cursor", start, end, start.AddDays(31), end.AddDays(31)));
        Assert.True(CalendarSyncRules.RequiresFullResync(false, "cursor", start, end, start.AddDays(32), end.AddDays(32)));

        // A changed window size is a different pull.
        Assert.True(CalendarSyncRules.RequiresFullResync(false, "cursor", start, end, start, end.AddDays(1)));
    }

    [Fact]
    public void A_planned_slot_is_the_first_five_minute_boundary_plus_stagger_not_before_the_window()
    {
        var link = new Guid("0199a000-0000-7000-8000-00000000abcd");
        var stagger = CalendarSyncRules.Stagger(link);
        Assert.InRange(stagger, TimeSpan.Zero, TimeSpan.FromSeconds(299));
        Assert.Equal(stagger, CalendarSyncRules.Stagger(link));

        var notBefore = new DateTimeOffset(2026, 9, 30, 12, 3, 10, TimeSpan.Zero);
        var (slot, fireAt) = CalendarSyncRules.PlannedSlot(link, notBefore);
        Assert.Equal(0, slot.Minute % 5);
        Assert.Equal(0, slot.Second);
        Assert.Equal(slot + stagger, fireAt);
        Assert.True(fireAt >= notBefore);
        Assert.True(fireAt - notBefore < TimeSpan.FromMinutes(5));

        // Replanned any time before it is due, the same slot is still the one desired - so the
        // planner never cancels a staggered trigger that has not fired yet.
        Assert.Equal((slot, fireAt), CalendarSyncRules.PlannedSlot(link, fireAt));
        Assert.Equal((slot, fireAt), CalendarSyncRules.PlannedSlot(link, fireAt.AddSeconds(-1)));
        var (next, nextFire) = CalendarSyncRules.PlannedSlot(link, fireAt.AddSeconds(1));
        Assert.Equal(slot.AddMinutes(5), next);
        Assert.Equal(fireAt.AddMinutes(5), nextFire);
    }

    [Fact]
    public void Trigger_keys_round_trip_and_name_distinct_jobs_per_source()
    {
        var link = new Guid("0199a000-0000-7000-8000-00000000abcd");
        var minute = new DateTimeOffset(2026, 9, 30, 12, 5, 0, TimeSpan.Zero);

        var planned = CalendarSyncRules.PlannedKey(link, minute);
        var dirty = CalendarSyncRules.DirtyKey(link, minute);
        Assert.Equal("cal:p:0199a000-0000-7000-8000-00000000abcd:202609301205", planned);
        Assert.Equal("cal:d:0199a000-0000-7000-8000-00000000abcd:202609301205", dirty);

        Assert.True(CalendarSyncRules.TryParseKey(planned, out var parsedPlanned));
        Assert.Equal(new CalendarTriggerKey(CalendarTriggerKind.Planned, link, minute), parsedPlanned);
        Assert.True(CalendarSyncRules.TryParseKey(dirty, out var parsedDirty));
        Assert.Equal(CalendarTriggerKind.Dirty, parsedDirty.Kind);

        Assert.Equal("link:0199a000-0000-7000-8000-00000000abcd:p:202609301205", CalendarSyncRules.JobKey(parsedPlanned));
        Assert.Equal("link:0199a000-0000-7000-8000-00000000abcd:d:202609301205", CalendarSyncRules.JobKey(parsedDirty));
        Assert.Equal("link:0199a000-0000-7000-8000-00000000abcd:now:202609301205:f", CalendarSyncRules.NowJobKey(link, minute.AddSeconds(42), full: true));
        Assert.Equal("link:0199a000-0000-7000-8000-00000000abcd:now:202609301205:i", CalendarSyncRules.NowJobKey(link, minute, full: false));
    }

    [Theory]
    [InlineData("")]
    [InlineData("cal:x:0199a000-0000-7000-8000-00000000abcd:202609301205")]
    [InlineData("cal:p:not-a-guid:202609301205")]
    [InlineData("cal:p:0199a000-0000-7000-8000-00000000abcd:2026093012")]
    [InlineData("cal:p:0199a000-0000-7000-8000-00000000abcd:202613301205")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000abcd:202609301205")]
    public void A_malformed_key_does_not_parse(string key) =>
        Assert.False(CalendarSyncRules.TryParseKey(key, out _));

    [Theory]
    [InlineData("2026-10-05", "2026-10-05T00:00:00+00:00")]
    [InlineData("2026-10-01T09:00:00-04:00[America/New_York]", "2026-10-01T13:00:00+00:00")]
    public void An_event_start_resolves_to_an_instant(string value, string expected) =>
        Assert.Equal(DateTimeOffset.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), CalendarSyncRules.StartInstant(value));

    [Theory]
    [InlineData("")]
    [InlineData("tomorrow")]
    [InlineData("2026-13-01")]
    public void A_start_that_is_not_a_date_or_timestamp_has_no_instant(string value) =>
        Assert.Null(CalendarSyncRules.StartInstant(value));

    [Fact]
    public void Bounded_detail_is_cut_to_500_characters() =>
        Assert.Equal(500, CalendarSyncRules.Bound(new string('x', 900), CalendarSyncRules.MaxDetailLength).Length);
}
