namespace Nix.Features.Habits;

/// <summary>
/// A daily or selected-weekday schedule. Weekdays use Sunday=0 through Saturday=6.
/// </summary>
/// <param name="ReminderTime">
/// The local time, as <c>HH:mm</c>, a reminder fires on a scheduled day with no check-in yet - in
/// this habit's own <see cref="Timezone"/>, per ADR-0051 section 4. <see langword="null"/> to
/// leave the habit without a reminder.
/// </param>
public sealed record HabitSettingsRequest(
    string Frequency,
    IReadOnlyList<int>? Weekdays,
    string Timezone,
    DateOnly StartDate,
    decimal Target,
    string Unit,
    string? ReminderTime = null);

/// <summary>Absolute daily progress. Quantity, when present, determines completion against the target.</summary>
public sealed record HabitCheckInRequest(bool Completed, decimal? Quantity);

/// <summary>An ordinary child item recording one local day's progress.</summary>
public sealed record HabitCheckInResponse(Guid Id, DateOnly OccurredOn, bool Completed, decimal? Quantity);

/// <summary>Progress for the requested portion of a Monday-based week.</summary>
public sealed record HabitWeekSummary(DateOnly WeekStart, int Planned, int Completed, decimal Quantity);

/// <summary>The authoritative settings and recorded progress within the requested inclusive range.</summary>
public sealed record HabitTrackerResponse(Guid HabitId, string Frequency, IReadOnlyList<int> Weekdays, string Timezone, DateOnly StartDate, decimal Target, string Unit, IReadOnlyList<HabitCheckInResponse> CheckIns, IReadOnlyList<HabitWeekSummary> Weeks, string Status = "active", IReadOnlyList<HabitOccurrence>? Occurrences = null, HabitProgress? Progress = null, IReadOnlyList<HabitMonthSummary>? Months = null, string? ReminderTime = null);

/// <summary>Lifecycle state for a habit. Paused habits retain history and accept no new check-ins.</summary>
public sealed record HabitStatusRequest(string Status);

public sealed record HabitStatusResponse(Guid HabitId, string Status);

public sealed record HabitOccurrence(DateOnly Date, bool Scheduled, string State, decimal Target, string Unit, decimal? Quantity, bool Completed);
public sealed record HabitProgress(int CurrentStreak, int BestStreak, int Planned, int Completed, decimal CompletionRate, decimal Quantity);
public sealed record HabitMonthSummary(string Month, int Planned, int Completed, decimal Quantity);
