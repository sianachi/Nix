using System.Globalization;

namespace Nix.Domain.Automations;

/// <summary>Which trigger path produced an automation key.</summary>
public enum AutomationKeyKind
{
    /// <summary>A planned schedule occurrence.</summary>
    Schedule,

    /// <summary>A planned date_arrives instant for one item.</summary>
    Date,

    /// <summary>A property change the database trigger enqueued.</summary>
    Property,

    /// <summary>A person ran the rule by hand.</summary>
    Manual,
}

/// <summary>What a parsed automation key names.</summary>
/// <param name="Kind">Which trigger path built it.</param>
/// <param name="RuleId">The rule, or <see cref="Guid.Empty"/> for a manual key (the rule travels separately).</param>
/// <param name="Day">The local occurrence day, for a schedule key.</param>
/// <param name="ItemId">The triggering item, for a date or property key.</param>
/// <param name="Instant">The exact fire instant, as UTC, for a date key.</param>
/// <param name="Depth">The causation depth: the database trigger's for a property key, zero otherwise.</param>
public readonly record struct AutomationKey(
    AutomationKeyKind Kind,
    Guid RuleId,
    DateOnly? Day,
    Guid? ItemId,
    DateTimeOffset? Instant,
    int Depth);

/// <summary>
/// The dedupe and trigger keys automations use - built from identifiers only, never user text
/// (ADR-0051 Amendment 1) - and the one parser the executor reads them back with.
/// </summary>
/// <remarks>
/// The same key is the <c>scheduled_trigger.dedupe_key</c> that makes planning idempotent and the
/// <c>automation_run.trigger_key</c> whose uniqueness per rule makes a redelivered trigger record one
/// run. The property key is built in SQL by <c>nix_enqueue_automation_property_changes</c>;
/// <see cref="Property"/> spells the same thing for tests and must stay in step with it.
/// </remarks>
public static class AutomationDedupeKeys
{
    /// <summary>The longest key any builder here produces, matching the columns' bound.</summary>
    public const int MaximumLength = 200;

    private const string AutoPrefix = "auto:";
    private const string ManualPrefix = "manual:";

    /// <summary>A schedule occurrence on a local day.</summary>
    public static string Schedule(Guid ruleId, DateOnly day) =>
        $"{AutoPrefix}{ruleId:D}:s:{day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}";

    /// <summary>A date_arrives instant for one item.</summary>
    public static string Date(Guid ruleId, Guid itemId, DateTimeOffset instant) =>
        $"{AutoPrefix}{ruleId:D}:d:{itemId:D}:{instant.UtcDateTime.ToString("O", CultureInfo.InvariantCulture)}";

    /// <summary>A property change at a depth, coalesced to the UTC minute it happened in.</summary>
    public static string Property(Guid ruleId, int depth, Guid itemId, DateTimeOffset at) =>
        $"{AutoPrefix}{ruleId:D}:p{depth.ToString(CultureInfo.InvariantCulture)}:{itemId:D}:{at.UtcDateTime.ToString("yyyyMMddHHmm", CultureInfo.InvariantCulture)}";

    /// <summary>
    /// The run key a rule records when its hourly cap trips: one per rule per UTC hour, so a burst
    /// the cap refuses leaves one throttled run, not one per refused trigger. A run key only -
    /// never a trigger's dedupe key, so <see cref="TryParse"/> does not read it.
    /// </summary>
    public static string HourlyThrottle(Guid ruleId, DateTimeOffset at) =>
        $"{AutoPrefix}{ruleId:D}:throttled:{at.UtcDateTime.ToString("yyyyMMddHH", CultureInfo.InvariantCulture)}";

    /// <summary>A hand-started run: unique per call.</summary>
    public static string Manual() => $"{ManualPrefix}{Guid.CreateVersion7():D}";

    /// <summary>Reads a key back, or returns <see langword="false"/> for anything this file did not build.</summary>
    public static bool TryParse(string? key, out AutomationKey parsed)
    {
        parsed = default;
        if (string.IsNullOrEmpty(key) || key.Length > MaximumLength)
        {
            return false;
        }

        if (key.StartsWith(ManualPrefix, StringComparison.Ordinal))
        {
            if (!Guid.TryParseExact(key[ManualPrefix.Length..], "D", out _))
            {
                return false;
            }

            parsed = new AutomationKey(AutomationKeyKind.Manual, Guid.Empty, null, null, null, 0);
            return true;
        }

        if (!key.StartsWith(AutoPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var parts = key[AutoPrefix.Length..].Split(':');
        if (parts.Length < 3 || !Guid.TryParseExact(parts[0], "D", out var ruleId))
        {
            return false;
        }

        switch (parts[1])
        {
            case "s" when parts.Length == 3
                && DateOnly.TryParseExact(parts[2], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day):
                parsed = new AutomationKey(AutomationKeyKind.Schedule, ruleId, day, null, null, 0);
                return true;

            // The instant's own "HH:mm:ss" colons split it into three more parts.
            case "d" when parts.Length == 6 && Guid.TryParseExact(parts[2], "D", out var dateItem)
                && DateTimeOffset.TryParseExact(
                    string.Join(':', parts[3..]),
                    "O",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var instant):
                parsed = new AutomationKey(AutomationKeyKind.Date, ruleId, null, dateItem, instant.ToUniversalTime(), 0);
                return true;

            case var depthPart when depthPart.Length > 1 && depthPart[0] == 'p' && parts.Length == 4
                && int.TryParse(depthPart.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out var depth)
                && Guid.TryParseExact(parts[2], "D", out var propertyItem)
                && DateTime.TryParseExact(parts[3], "yyyyMMddHHmm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _):
                parsed = new AutomationKey(AutomationKeyKind.Property, ruleId, null, propertyItem, null, depth);
                return true;

            default:
                return false;
        }
    }
}
