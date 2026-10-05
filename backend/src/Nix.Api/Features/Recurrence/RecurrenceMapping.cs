using System.Collections.Immutable;
using System.Globalization;
using Nix.Domain.Primitives;
using Nix.Domain.Recurrence;

namespace Nix.Features.Recurrence;

/// <summary>
/// Maps between the recurrence wire contract and the domain.
/// </summary>
/// <remarks>
/// <para>
/// <b>The vocabulary here must match <c>RecurrenceRuleJson</c>'s exactly</b> - the same
/// <c>daily</c>/<c>weekly</c>/<c>monthly</c>/<c>yearly</c> and <c>mo</c>..<c>su</c> spellings - so
/// that what an endpoint accepts is what storage would have read back had it been written any other
/// way. It cannot simply call into that reader, though: <c>RecurrenceRuleJson.Read</c> is total and
/// answers only "readable or not", one bit for every reason a document could be wrong, which is
/// the right shape for loading storage a client never sees and the wrong shape for a request
/// somebody is waiting on an answer to. This is where each reason gets its own stable code instead.
/// </para>
/// <para>
/// <b>Duplicate weekdays are refused, not de-duplicated.</b> Silently dropping part of what a
/// caller sent would mean the rule now in force is not the one they asked for, which is the same
/// reasoning <c>ItemProperties.Merge</c> applies to a repeated JSON member.
/// </para>
/// </remarks>
internal static class RecurrenceMapping
{
    /// <summary>The accepted weekday codes, for the message a caller sees when they miss.</summary>
    private static readonly string AcceptedWeekdays = string.Join(
        ", ",
        Enum.GetValues<IsoDayOfWeek>().Select(WeekdayText));

    /// <summary>Reads a requested rule, or says which part of it could not be accepted.</summary>
    /// <param name="request">The request.</param>
    /// <returns>The domain rule, with no completion state of its own, or why it was refused.</returns>
    internal static Result<RecurrenceRule> ToDomain(SetRecurrenceRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!TryFrequency(request.Freq, out var frequency))
        {
            return Result.Failure<RecurrenceRule>(
                RecurrenceRequestErrors.InvalidFrequency(
                    $"'{request.Freq}' is not a recognised frequency. Expected one of: daily, weekly, monthly, yearly."));
        }

        if (request.Interval is < 1 or > RecurrenceRuleJson.MaximumInterval)
        {
            return Result.Failure<RecurrenceRule>(
                RecurrenceRequestErrors.InvalidInterval(
                    $"interval must be between 1 and {RecurrenceRuleJson.MaximumInterval}."));
        }

        var weekdaysRequested = request.Weekdays is { Count: > 0 };
        if (weekdaysRequested && frequency != RecurrenceFrequency.Weekly)
        {
            return Result.Failure<RecurrenceRule>(
                RecurrenceRequestErrors.WeekdaysRequireWeekly(
                    "weekdays may only be given on a weekly rule."));
        }

        var weekdays = ImmutableArray<IsoDayOfWeek>.Empty;
        if (weekdaysRequested)
        {
            var builder = ImmutableArray.CreateBuilder<IsoDayOfWeek>(request.Weekdays!.Count);
            foreach (var text in request.Weekdays!)
            {
                if (!TryWeekday(text, out var weekday))
                {
                    return Result.Failure<RecurrenceRule>(
                        RecurrenceRequestErrors.InvalidWeekday(
                            $"'{text}' is not a recognised weekday. Expected one of: {AcceptedWeekdays}."));
                }

                if (builder.Contains(weekday))
                {
                    return Result.Failure<RecurrenceRule>(
                        RecurrenceRequestErrors.InvalidWeekday($"'{text}' was named more than once."));
                }

                builder.Add(weekday);
            }

            weekdays = builder.ToImmutable();
        }

        DateOnly? until = null;
        if (request.Until is { Length: > 0 } untilText)
        {
            if (!TryDay(untilText, out var parsed))
            {
                return Result.Failure<RecurrenceRule>(
                    RecurrenceRequestErrors.InvalidUntil($"'{untilText}' is not a yyyy-MM-dd date."));
            }

            until = parsed;
        }

        return Result.Success(
            new RecurrenceRule(frequency, request.Interval, weekdays, until, null, ImmutableArray<DateOnly>.Empty));
    }

    /// <summary>Maps a domain rule onto the published shape.</summary>
    /// <param name="rule">The rule, or <see langword="null"/> when the item has none.</param>
    /// <returns>The published shape, or <see langword="null"/> to match.</returns>
    internal static RecurrenceRuleResponse? ToResponse(RecurrenceRule? rule) =>
        rule is null
            ? null
            : new RecurrenceRuleResponse(
                FrequencyText(rule.Frequency),
                rule.Interval,
                [.. rule.Weekdays.Select(WeekdayText)],
                rule.Until is { } until ? Iso(until) : null,
                rule.CompletedThrough is { } through ? Iso(through) : null,
                [.. rule.Completed.Select(Iso)]);

    /// <summary>Reads a <c>yyyy-MM-dd</c> day.</summary>
    /// <param name="text">The text to parse.</param>
    /// <param name="day">The parsed day, when it could be read.</param>
    /// <returns><see langword="true"/> when <paramref name="text"/> is a valid day.</returns>
    internal static bool TryDay(string text, out DateOnly day)
    {
        ArgumentNullException.ThrowIfNull(text);
        return DateOnly.TryParseExact(
            text,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out day);
    }

    /// <summary>
    /// The anchor day an item's own due date names, or <see langword="null"/> when it carries
    /// nothing usable.
    /// </summary>
    /// <param name="dueDay">
    /// The item's own reserved <c>due_date</c> property, as <see cref="Nix.Domain.Items.Item.DueDay"/>
    /// carries it - already narrowed to its first ten characters by the stored generated column.
    /// </param>
    /// <returns>The anchor, or <see langword="null"/> when the item has none, or it is not a day.</returns>
    /// <remarks>
    /// Text that is not a day is treated as absent rather than guessed at, the same answer
    /// <c>RecurrenceCandidateReader.ReadAnchor</c> gives the calendar for the same column.
    /// </remarks>
    internal static DateOnly? ReadAnchor(string? dueDay) =>
        dueDay is not null && TryDay(dueDay, out var day) ? day : null;

    private static bool TryFrequency(string? text, out RecurrenceFrequency frequency)
    {
        switch (text)
        {
            case "daily":
                frequency = RecurrenceFrequency.Daily;
                return true;
            case "weekly":
                frequency = RecurrenceFrequency.Weekly;
                return true;
            case "monthly":
                frequency = RecurrenceFrequency.Monthly;
                return true;
            case "yearly":
                frequency = RecurrenceFrequency.Yearly;
                return true;
            default:
                frequency = default;
                return false;
        }
    }

    private static string FrequencyText(RecurrenceFrequency frequency) => frequency switch
    {
        RecurrenceFrequency.Daily => "daily",
        RecurrenceFrequency.Weekly => "weekly",
        RecurrenceFrequency.Monthly => "monthly",
        RecurrenceFrequency.Yearly => "yearly",
        _ => throw new ArgumentOutOfRangeException(nameof(frequency), frequency, "Unknown frequency."),
    };

    private static bool TryWeekday(string? text, out IsoDayOfWeek weekday)
    {
        switch (text)
        {
            case "mo":
                weekday = IsoDayOfWeek.Monday;
                return true;
            case "tu":
                weekday = IsoDayOfWeek.Tuesday;
                return true;
            case "we":
                weekday = IsoDayOfWeek.Wednesday;
                return true;
            case "th":
                weekday = IsoDayOfWeek.Thursday;
                return true;
            case "fr":
                weekday = IsoDayOfWeek.Friday;
                return true;
            case "sa":
                weekday = IsoDayOfWeek.Saturday;
                return true;
            case "su":
                weekday = IsoDayOfWeek.Sunday;
                return true;
            default:
                weekday = default;
                return false;
        }
    }

    private static string WeekdayText(IsoDayOfWeek weekday) => weekday switch
    {
        IsoDayOfWeek.Monday => "mo",
        IsoDayOfWeek.Tuesday => "tu",
        IsoDayOfWeek.Wednesday => "we",
        IsoDayOfWeek.Thursday => "th",
        IsoDayOfWeek.Friday => "fr",
        IsoDayOfWeek.Saturday => "sa",
        IsoDayOfWeek.Sunday => "su",
        _ => throw new ArgumentOutOfRangeException(nameof(weekday), weekday, "Unknown weekday."),
    };

    private static string Iso(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
