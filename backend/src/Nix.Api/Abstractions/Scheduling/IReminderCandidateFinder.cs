using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Scheduling;

/// <summary>An item carrying a <c>reminder</c> property whose instant falls in a plan window.</summary>
public sealed record ExplicitReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    DateTimeOffset ReminderAt);

/// <summary>
/// An item carrying <c>due_date</c> whose one occurrence, or whose recurring rule's anchor, could
/// produce an occurrence in a plan window.
/// </summary>
/// <param name="Recurrence">
/// The item's recurrence rule as stored JSON, or <see langword="null"/> for a plain, non-recurring
/// due item.
/// </param>
/// <param name="Completed">
/// Whether the plain due item is complete. Meaningless for a recurring item - a recurring item's
/// completion lives inside <paramref name="Recurrence"/> itself
/// (<see cref="Nix.Domain.Recurrence.RecurrenceRule.IsCompleted"/>), never in this flag.
/// </param>
public sealed record DueReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    DateOnly DueDay,
    string? Recurrence,
    bool Completed);

/// <summary>An item declaring a habit reminder time, with the scheduling properties needed to plan it.</summary>
/// <param name="Settings">
/// The item's <c>$habit_</c>-prefixed scheduling properties, as a JSON object
/// <see cref="Nix.Domain.Habits.HabitSettings.Read"/> reads directly - never the title, and never
/// any other property the item carries.
/// </param>
public sealed record HabitReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    string Settings);

/// <summary>
/// One recipient's reminder preferences, defaulted exactly as a fresh <c>principal_preferences</c>
/// row would be (ADR-0051 section 3) when they have never saved one at all.
/// </summary>
public sealed record ReminderPreferences(
    PrincipalId PrincipalId,
    string TimeZone,
    TimeOnly? QuietStart,
    TimeOnly? QuietEnd,
    TimeOnly DueReminderTime,
    bool DueReminders,
    bool HabitReminders,
    IReadOnlyList<Guid> MutedContainerIds);

/// <summary>
/// Cross-tenant discovery for the three reminder sources, backed by the SECURITY DEFINER functions
/// in <c>ReminderSourceSecuritySql</c> - the only cross-tenant reader of <c>item</c> and
/// <c>principal_preferences</c> these sources need, exactly as <see cref="IScheduledTriggerLeaseStore"/>
/// is for <c>scheduled_trigger</c>. Called from <c>ITriggerSource.PlanAsync</c>, which runs with no
/// session established yet.
/// </summary>
public interface IReminderCandidateFinder
{
    /// <summary>
    /// Items with a <c>reminder</c> property firing in <c>[from, until)</c>, one keyset page at a
    /// time - <paramref name="afterInstant"/>/<paramref name="afterId"/> default to "the
    /// beginning"; a caller pages by passing back the last row's own instant and id.
    /// </summary>
    /// <remarks>
    /// Paged rather than a single bounded call: without a cursor, whichever 500 candidates a
    /// single page happens to hold would permanently starve every candidate that sorts after
    /// them the moment more than 500 exist globally at once - not merely slower, but silently
    /// unreachable, for however many recipients that turns out to be.
    /// </remarks>
    public Task<IReadOnlyList<ExplicitReminderCandidate>> FindExplicitAsync(
        DateTimeOffset from,
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>
    /// Items with <c>due_date</c> whose due day falls in <c>[from, until]</c>, or that recur into
    /// it, one keyset page at a time - see <see cref="FindExplicitAsync"/>'s remarks.
    /// </summary>
    public Task<IReadOnlyList<DueReminderCandidate>> FindDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        DateOnly afterDay,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>Every item declaring a habit reminder time, one keyset page at a time - see <see cref="FindExplicitAsync"/>'s remarks.</summary>
    public Task<IReadOnlyList<HabitReminderCandidate>> FindHabitsAsync(
        int limit, Guid afterId, CancellationToken cancellationToken);

    /// <summary>Reminder preferences for a batch of recipients, defaulted for any with no saved row.</summary>
    public Task<IReadOnlyList<ReminderPreferences>> PreferencesForAsync(
        IReadOnlyCollection<PrincipalId> principalIds, CancellationToken cancellationToken);
}
