namespace Nix.Domain.Recurrence;

/// <summary>
/// The occurrences a rule produces in a window, computed rather than stored.
/// </summary>
/// <remarks>
/// <para>
/// <b>Read-time expansion, no materialised rows and no scheduler.</b> A series is a rule plus an
/// anchor; the days it lands on are a function of those two and the window being drawn. Storing
/// occurrences would mean a background job creating rows nobody asked for, a decision about how
/// far ahead to create them, and a reconciliation when the rule changes. Computing them means a
/// rule edit is retroactive by construction and there is nothing to reconcile.
/// </para>
/// <para>
/// <b>Lazy and ascending, because the caller merges.</b> The calendar merges these against
/// concrete entries under one ceiling, so a generator that produced its whole window eagerly
/// would compute up to 400 days per item for a merge that may take three. Enumerating on demand
/// keeps the merge's cost proportional to what it takes, not to what it could have taken.
/// </para>
/// <para>
/// <b>Month ends clamp, they never skip.</b> Monthly from the 31st yields the 30th in a 30-day
/// month and the 28th or 29th in February; yearly from Feb 29 yields Feb 28 off leap years. The
/// alternative - skipping months a rule cannot land in - makes a monthly series silently miss
/// months, which every reader reads as a bug.
/// </para>
/// </remarks>
public static class RecurrenceExpansion
{
    /// <summary>
    /// The days a rule lands on within a window, ascending.
    /// </summary>
    /// <param name="rule">The rule.</param>
    /// <param name="anchor">The series' first day - the item's own due date.</param>
    /// <param name="from">The window's first day, inclusive.</param>
    /// <param name="to">The window's last day, inclusive.</param>
    /// <returns>Each occurrence day in the window, lazily.</returns>
    /// <remarks>
    /// The anchor itself is an occurrence. A window starting before the anchor yields from the
    /// anchor; a window starting after it steps forward to the first occurrence at or after
    /// <paramref name="from"/> rather than walking every intervening day.
    /// </remarks>
    public static IEnumerable<DateOnly> Occurrences(
        RecurrenceRule rule,
        DateOnly anchor,
        DateOnly from,
        DateOnly to)
    {
        ArgumentNullException.ThrowIfNull(rule);

        var last = rule.Until is { } until && until < to ? until : to;
        if (last < anchor || last < from)
        {
            return [];
        }

        // Weekly with named weekdays walks weeks and emits the named days inside each; every
        // other shape steps one occurrence at a time from the anchor.
        return rule.Frequency == RecurrenceFrequency.Weekly && !rule.Weekdays.IsDefaultOrEmpty
            ? WeeklyOnWeekdays(rule, anchor, from, last)
            : Stepped(rule, anchor, from, last);
    }

    /// <summary>Every occurrence of a non-weekday rule in the window, ascending.</summary>
    private static IEnumerable<DateOnly> Stepped(
        RecurrenceRule rule,
        DateOnly anchor,
        DateOnly from,
        DateOnly last)
    {
        for (var index = FirstIndexAtOrAfter(rule, anchor, from); ; index++)
        {
            var day = Advance(rule, anchor, index);
            if (day > last)
            {
                yield break;
            }

            if (day >= from)
            {
                yield return day;
            }
        }
    }

    /// <summary>
    /// Weekly with named weekdays: every named weekday inside every nth week from the anchor's.
    /// </summary>
    private static IEnumerable<DateOnly> WeeklyOnWeekdays(
        RecurrenceRule rule,
        DateOnly anchor,
        DateOnly from,
        DateOnly last)
    {
        // Weeks are counted from the anchor's own week, starting Monday, so "every second week"
        // means the same weeks whichever day inside one the anchor happens to be.
        var anchorWeekStart = StartOfWeek(anchor);
        var scanWeekStart = StartOfWeek(from < anchor ? anchor : from);

        // Round back to a week the interval actually lands on.
        var weeksApart = (scanWeekStart.DayNumber - anchorWeekStart.DayNumber) / 7;
        var alignedWeeks = weeksApart - (weeksApart % rule.Interval);
        var weekStart = anchorWeekStart.AddDays(alignedWeeks * 7);

        for (; weekStart <= last; weekStart = weekStart.AddDays(7 * rule.Interval))
        {
            foreach (var weekday in rule.Weekdays)
            {
                var day = weekStart.AddDays((int)weekday - 1);
                if (day < anchor || day < from)
                {
                    continue;
                }

                if (day > last)
                {
                    yield break;
                }

                yield return day;
            }
        }
    }

    /// <summary>The occurrence index at or after a day, without walking the ones before it.</summary>
    private static int FirstIndexAtOrAfter(RecurrenceRule rule, DateOnly anchor, DateOnly from)
    {
        if (from <= anchor)
        {
            return 0;
        }

        var estimate = rule.Frequency switch
        {
            RecurrenceFrequency.Daily => (from.DayNumber - anchor.DayNumber) / rule.Interval,
            RecurrenceFrequency.Weekly => (from.DayNumber - anchor.DayNumber) / (7 * rule.Interval),
            RecurrenceFrequency.Monthly => MonthsBetween(anchor, from) / rule.Interval,
            RecurrenceFrequency.Yearly => (from.Year - anchor.Year) / rule.Interval,
            _ => 0,
        };

        // The estimate can land a step early (clamping and integer division both round down), so
        // walk forward the few steps it takes rather than trusting the arithmetic exactly.
        var index = Math.Max(0, estimate);
        while (Advance(rule, anchor, index) < from)
        {
            index++;
        }

        return index;
    }

    /// <summary>The nth occurrence of a rule from its anchor, clamped where the calendar demands.</summary>
    private static DateOnly Advance(RecurrenceRule rule, DateOnly anchor, int index) =>
        rule.Frequency switch
        {
            RecurrenceFrequency.Daily => anchor.AddDays(index * rule.Interval),
            RecurrenceFrequency.Weekly => anchor.AddDays(index * rule.Interval * 7),
            RecurrenceFrequency.Monthly => ClampedAddMonths(anchor, index * rule.Interval),
            RecurrenceFrequency.Yearly => ClampedAddMonths(anchor, index * rule.Interval * 12),
            _ => anchor,
        };

    /// <summary>
    /// Adds months, keeping the anchor's day where the target month has one and taking that
    /// month's last day where it does not - the 31st becomes the 30th, or the 28th, never a skip.
    /// </summary>
    private static DateOnly ClampedAddMonths(DateOnly anchor, int months)
    {
        var shifted = anchor.AddMonths(months);
        var daysInMonth = DateTime.DaysInMonth(shifted.Year, shifted.Month);
        var day = Math.Min(anchor.Day, daysInMonth);
        return new DateOnly(shifted.Year, shifted.Month, day);
    }

    private static int MonthsBetween(DateOnly from, DateOnly to) =>
        ((to.Year - from.Year) * 12) + to.Month - from.Month;

    /// <summary>The Monday of a day's week.</summary>
    private static DateOnly StartOfWeek(DateOnly day)
    {
        var isoDay = day.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)day.DayOfWeek;
        return day.AddDays(1 - isoDay);
    }
}
