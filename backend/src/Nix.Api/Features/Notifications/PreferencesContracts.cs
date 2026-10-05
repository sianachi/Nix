using Nix.Messaging;

namespace Nix.Features.Notifications;

/// <summary>The saved preferences document and its concurrency version.</summary>
/// <param name="TimeZone">The IANA zone reminders and quiet hours resolve in, such as "Europe/London".</param>
/// <param name="QuietStart">The local time quiet hours begin, as "HH:mm", or <see langword="null"/>.</param>
/// <param name="QuietEnd">The local time quiet hours end, as "HH:mm", or <see langword="null"/>.</param>
/// <param name="DueReminderTime">The local time a due-task reminder fires, as "HH:mm".</param>
public sealed record PrincipalPreferencesResponse(long Revision, string TimeZone, string? QuietStart,
    string? QuietEnd, string DueReminderTime, bool DueReminders, bool HabitReminders,
    IReadOnlyList<Guid> MutedContainerIds);

/// <summary>The fields a caller may set. Used for both the read default and a write.</summary>
public sealed record PreferencesInput(string TimeZone, string? QuietStart, string? QuietEnd,
    string DueReminderTime, bool DueReminders, bool HabitReminders, IReadOnlyList<Guid> MutedContainerIds);

/// <summary>Replaces the owner's preferences only at the version they edited.</summary>
public sealed record SavePreferencesRequest(long ExpectedRevision, PreferencesInput Preferences);

/// <summary>Reads the caller's own preferences, defaulted when never saved.</summary>
public sealed record GetPreferences : IQuery<PrincipalPreferencesResponse>;

/// <summary>Replaces the caller's own preferences using a compare-and-swap revision.</summary>
public sealed record SavePreferences(long ExpectedRevision, PreferencesInput Preferences) : ICommand<PrincipalPreferencesResponse>;
