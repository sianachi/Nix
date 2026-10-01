using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Domain.Scheduling;

namespace Nix.Domain.Automations;

/// <summary>When a <see cref="DateArrivesTrigger"/> fires for one item's stored value.</summary>
/// <remarks>
/// A date-only value (<c>yyyy-MM-dd</c>) fires at the rule's time in the owner's zone; a timestamp
/// (RFC 3339, optionally with an RFC 9557 bracketed zone, as the property validator stores it) fires
/// at its own instant. The offset is applied last. Anything else - an undeclared key can hold
/// anything - never fires. The planner and the executor call this same function, so the instant a
/// trigger was planned for is exactly the one re-verified at fire time.
/// </remarks>
public static class AutomationDateInstant
{
    /// <summary>The instant the rule fires for <paramref name="value"/>, or <see langword="null"/> when it never does.</summary>
    public static DateTimeOffset? Resolve(JsonNode? value, TimeOnly time, int offsetMinutes, string ownerZone) =>
        value is JsonValue text && text.TryGetValue<string>(out var s) ? Resolve(s, time, offsetMinutes, ownerZone) : null;

    /// <summary>The instant the rule fires for a stored text value, or <see langword="null"/>.</summary>
    public static DateTimeOffset? Resolve(string? text, TimeOnly time, int offsetMinutes, string ownerZone)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        if (text.Length == 10
            && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
        {
            return ReminderQuietHours.ResolveLocalInstant(day, time, ownerZone).AddMinutes(offsetMinutes);
        }

        var bracket = text.IndexOf('[', StringComparison.Ordinal);
        var instantText = bracket >= 0 ? text[..bracket] : text;

        // An instant needs an explicit time and offset; a bare local date-time names no instant.
        if (instantText.Length < 16 || instantText[10] != 'T')
        {
            return null;
        }

        return DateTimeOffset.TryParse(
            instantText,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal,
            out var instant)
            && HasOffset(instantText)
                ? instant.ToUniversalTime().AddMinutes(offsetMinutes)
                : null;
    }

    private static bool HasOffset(string text) =>
        text.EndsWith('Z') || text.EndsWith('z') || text.LastIndexOfAny(['+', '-']) > 10;
}
