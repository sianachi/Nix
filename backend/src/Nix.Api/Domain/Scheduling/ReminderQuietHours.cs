using NodaTime;

namespace Nix.Domain.Scheduling;

/// <summary>
/// Resolves a local day and time-of-day to an instant, and defers a computed fire instant out of
/// a principal's quiet hours, both in the zone's own local time.
/// </summary>
/// <remarks>
/// <para>
/// ADR-0051 section 4: "quiet hours defer a trigger to <c>quiet_end</c>". The window is read in
/// local time because that is what a person means by "quiet between 22:00 and 07:00" - the instant
/// it corresponds to moves with daylight saving, the local wall-clock time it names does not.
/// </para>
/// <para>
/// <b>NodaTime's Tzdb, resolved leniently, never <see cref="TimeZoneInfo"/>.</b> A local time can
/// name an instant that does not exist (a spring-forward gap: America/New_York has no 2027-03-14
/// 02:30) or one that exists twice (a fall-back overlap). <see cref="TimeZoneInfo.ConvertTimeToUtc(DateTime, TimeZoneInfo)"/>
/// throws on the gap case, which - reached through an ordinary due_reminder_time, habit
/// reminderTime or quiet_end that merely happens to fall in the one skipped half-hour each spring
/// - would abort planning for every tenant in the same pass, not just the trigger it was
/// computing. NodaTime's lenient resolver instead maps a gap to the instant just after it and an
/// overlap to the earlier of the two candidates, deterministically, never throwing - which is what
/// every call in this file needs from a local time it did not choose and cannot refuse. It is also
/// the same zone database <c>PropertyValidator.CheckTimestamp</c> already resolves reminder
/// timestamps against, per ADR-0051 section 3's "never the host database".
/// </para>
/// </remarks>
public static class ReminderQuietHours
{
    /// <summary>The zone database every reminder instant is resolved against - NodaTime's own copy, never the host's.</summary>
    private static readonly IDateTimeZoneProvider Zones = DateTimeZoneProviders.Tzdb;

    /// <summary>
    /// The instant a local day and time-of-day name in a zone, resolved leniently.
    /// </summary>
    /// <param name="day">The local calendar day.</param>
    /// <param name="time">The local time of day.</param>
    /// <param name="timeZone">The IANA zone the day and time are local to.</param>
    /// <returns>The instant, as UTC.</returns>
    public static DateTimeOffset ResolveLocalInstant(DateOnly day, TimeOnly time, string timeZone)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(timeZone);

        var zone = Zones.GetZoneOrNull(timeZone)
            ?? throw new ArgumentException($"'{timeZone}' is not a time zone this build knows.", nameof(timeZone));
        var local = new LocalDateTime(day.Year, day.Month, day.Day, time.Hour, time.Minute, time.Second);
        var instant = zone.AtLeniently(local).ToInstant();
        return instant.ToDateTimeOffset();
    }

    /// <summary>
    /// Moves <paramref name="fireAt"/> to <paramref name="quietEnd"/>, in <paramref name="timeZone"/>,
    /// when it falls inside the quiet window; returns it unchanged otherwise.
    /// </summary>
    /// <param name="fireAt">The instant a source computed, before quiet hours are considered.</param>
    /// <param name="timeZone">The principal's own IANA time zone.</param>
    /// <param name="quietStart">The local time quiet hours begin, or <see langword="null"/> for none configured.</param>
    /// <param name="quietEnd">The local time quiet hours end. Present exactly when <paramref name="quietStart"/> is.</param>
    /// <returns><paramref name="fireAt"/>, or the same day's (or the next day's) <paramref name="quietEnd"/>.</returns>
    /// <remarks>
    /// <para>
    /// <b>The window may cross midnight</b> - 22:00 to 07:00 names the same window whichever side
    /// of midnight the moment being checked falls on. When <paramref name="quietStart"/> is after
    /// <paramref name="quietEnd"/>, "inside" means at or after the start <em>or</em> before the
    /// end; otherwise it means the ordinary contiguous range.
    /// </para>
    /// <para>
    /// <b>Which calendar day <paramref name="quietEnd"/> falls on depends on which side of
    /// midnight <paramref name="fireAt"/> landed on</b>, for the crossing case only: a moment at or
    /// after <paramref name="quietStart"/> (before midnight) defers to <paramref name="quietEnd"/>
    /// on the <em>next</em> local day; a moment already past midnight and before
    /// <paramref name="quietEnd"/> defers to <paramref name="quietEnd"/> on the <em>same</em> local
    /// day. The non-crossing case always defers within the same local day, since the whole window
    /// sits inside it.
    /// </para>
    /// </remarks>
    public static DateTimeOffset Apply(
        DateTimeOffset fireAt,
        string timeZone,
        TimeOnly? quietStart,
        TimeOnly? quietEnd)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(timeZone);

        if (quietStart is not { } start || quietEnd is not { } end)
        {
            return fireAt;
        }

        var zone = Zones.GetZoneOrNull(timeZone)
            ?? throw new ArgumentException($"'{timeZone}' is not a time zone this build knows.", nameof(timeZone));
        var local = Instant.FromDateTimeOffset(fireAt).InZone(zone);
        var localDay = new DateOnly(local.Year, local.Month, local.Day);
        var localTime = new TimeOnly(local.Hour, local.Minute, local.Second);

        var crossesMidnight = start > end;
        var beforeMidnightSide = crossesMidnight && localTime >= start;
        var inside = crossesMidnight
            ? localTime >= start || localTime < end
            : localTime >= start && localTime < end;

        if (!inside)
        {
            return fireAt;
        }

        var deferredDay = beforeMidnightSide ? localDay.AddDays(1) : localDay;
        return ResolveLocalInstant(deferredDay, end, timeZone);
    }
}
