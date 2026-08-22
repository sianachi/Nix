using Nix.Domain.Primitives;

namespace Nix.Features.Recurrence;

/// <summary>
/// The expected failures this feature's own request mapping and read-time guards raise, and the
/// stable codes clients branch on.
/// </summary>
/// <remarks>
/// <para>
/// The domain guard's own codes - a rule too large to store, a day the series does not land on, too
/// many out-of-order completions - are declared beside <c>RecurrenceWrites</c> in
/// <c>Nix.Domain.Recurrence.RecurrenceErrors</c> and are returned as-is by the handlers here rather
/// than re-declared: they are the same expected failure whichever endpoint reaches them.
/// </para>
/// <para>
/// What is declared here instead is everything upstream of that guard: a wire request that does not
/// map onto a <c>RecurrenceRule</c> at all, and the read-time facts a completion needs before the
/// domain guard has anything to check - whether the item has a rule, whether it has an anchor to
/// place occurrences against, and whether the rule this build stored is one this build can still
/// read back.
/// </para>
/// </remarks>
public static class RecurrenceRequestErrors
{
    /// <summary>Stable code for a <c>freq</c> outside the closed set.</summary>
    public const string InvalidFrequencyCode = "recurrence.invalid_frequency";

    /// <summary>Stable code for an <c>interval</c> outside 1..<c>RecurrenceRuleJson.MaximumInterval</c>.</summary>
    public const string InvalidIntervalCode = "recurrence.invalid_interval";

    /// <summary>Stable code for <c>weekdays</c> given on a rule whose frequency is not weekly.</summary>
    public const string WeekdaysRequireWeeklyCode = "recurrence.weekdays_require_weekly";

    /// <summary>Stable code for a weekday name outside the closed two-letter set.</summary>
    public const string InvalidWeekdayCode = "recurrence.invalid_weekday";

    /// <summary>Stable code for an <c>until</c> that is not a <c>yyyy-MM-dd</c> date.</summary>
    public const string InvalidUntilCode = "recurrence.invalid_until";

    /// <summary>Stable code for an <c>occurredOn</c> that is not a <c>yyyy-MM-dd</c> date.</summary>
    public const string InvalidOccurredOnCode = "recurrence.invalid_occurred_on";

    /// <summary>Stable code for an item that carries no recurrence rule.</summary>
    public const string NotRecurringCode = "recurrence.not_recurring";

    /// <summary>Stable code for an item with no due date to anchor a series to.</summary>
    public const string NoAnchorCode = "recurrence.no_anchor";

    /// <summary>Stable code for a stored rule this build cannot interpret.</summary>
    public const string UnreadableRuleCode = "recurrence.unreadable_rule";

    /// <summary>The requested frequency is not one this build recognises.</summary>
    public static NixError InvalidFrequency(string detail) => new(InvalidFrequencyCode, detail);

    /// <summary>The requested interval is out of range.</summary>
    public static NixError InvalidInterval(string detail) => new(InvalidIntervalCode, detail);

    /// <summary>Weekdays were named on a rule that does not repeat weekly.</summary>
    public static NixError WeekdaysRequireWeekly(string detail) => new(WeekdaysRequireWeeklyCode, detail);

    /// <summary>A named weekday is not one this build recognises.</summary>
    public static NixError InvalidWeekday(string detail) => new(InvalidWeekdayCode, detail);

    /// <summary>The requested <c>until</c> could not be read as a day.</summary>
    public static NixError InvalidUntil(string detail) => new(InvalidUntilCode, detail);

    /// <summary>The requested <c>occurredOn</c> could not be read as a day.</summary>
    public static NixError InvalidOccurredOn(string detail) => new(InvalidOccurredOnCode, detail);

    /// <summary>There is no rule stored for this item, so there is no series to act on.</summary>
    public static NixError NotRecurring(string detail) => new(NotRecurringCode, detail);

    /// <summary>The item has no due date, so its series has nothing to place occurrences against.</summary>
    public static NixError NoAnchor(string detail) => new(NoAnchorCode, detail);

    /// <summary>The stored rule could not be read by this build.</summary>
    public static NixError UnreadableRule(string detail) => new(UnreadableRuleCode, detail);
}
