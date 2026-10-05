using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Notifications;

/// <summary>Personal reminder and notification settings, never shared workspace content.</summary>
public sealed class PrincipalPreferences
{
    /// <summary>Gets the tenant whose principal owns these preferences.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the owner.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the IANA time zone reminders and quiet hours resolve in.</summary>
    public required string TimeZone { get; init; }

    /// <summary>Gets the local time quiet hours begin, or <see langword="null"/> when unset.</summary>
    public TimeOnly? QuietStart { get; init; }

    /// <summary>Gets the local time quiet hours end, or <see langword="null"/> when unset.</summary>
    public TimeOnly? QuietEnd { get; init; }

    /// <summary>Gets the local time a due-task reminder fires on the due day.</summary>
    public required TimeOnly DueReminderTime { get; init; }

    /// <summary>Gets whether due-task reminders are enabled.</summary>
    public required bool DueReminders { get; init; }

    /// <summary>Gets whether habit check-in reminders are enabled.</summary>
    public required bool HabitReminders { get; init; }

    /// <summary>Gets the containers (and their descendants) reminders and notifications are withheld for.</summary>
    public required IReadOnlyList<Guid> MutedContainerIds { get; init; }

    /// <summary>Gets the version used to refuse stale edits from other devices.</summary>
    public required long Revision { get; init; }
}
