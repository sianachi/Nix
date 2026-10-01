using System.Globalization;

namespace Nix.Domain.Scheduling;

/// <summary>
/// The dedupe keys the three reminder sources build, from identifiers alone - never from a title
/// or any other user-written text, per ADR-0051 Amendment 1's rule for every dedupe key in this
/// system.
/// </summary>
public static class ReminderDedupeKeys
{
    /// <summary>An explicit reminder: fires once, keyed by the item and the exact instant.</summary>
    public static string Explicit(Guid itemId, DateTimeOffset instant) =>
        $"reminder:{itemId:D}:{instant.UtcDateTime:O}";

    /// <summary>A due-task reminder occurrence: keyed by the item and the local occurrence day.</summary>
    public static string Due(Guid itemId, DateOnly occurrenceDay) =>
        $"due:{itemId:D}:{occurrenceDay.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}";

    /// <summary>A habit check-in reminder occurrence: keyed by the item and the local scheduled day.</summary>
    public static string Habit(Guid itemId, DateOnly scheduledDay) =>
        $"habit:{itemId:D}:{scheduledDay.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}";
}
