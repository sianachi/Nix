using Nix.Features.Habits;

namespace Nix.Features.MyDay;

/// <summary>What the caller should do today in one workspace, read from the original items.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="EvaluatedAt">The one instant every day below was computed from.</param>
/// <param name="TaskDay">The caller's current day in <paramref name="TaskTimezone"/>.</param>
/// <param name="TaskTimezone">The caller's saved IANA zone, UTC when they saved none.</param>
/// <param name="Tasks">Tasks due today, overdue, or assigned to the caller.</param>
/// <param name="Habits">Habits scheduled today, each on its own local day.</param>
public sealed record MyDayResponse(
    Guid WorkspaceId,
    DateTimeOffset EvaluatedAt,
    DateOnly TaskDay,
    string TaskTimezone,
    MyDayTaskSection Tasks,
    MyDayHabitSection Habits);

/// <summary>The task rows and what the read could not establish about them.</summary>
/// <param name="Rows">The rows, today first, then overdue, then assigned.</param>
/// <param name="Coverage">Whether <paramref name="Rows"/> is everything that qualifies.</param>
/// <param name="Limits">The ceilings this read ran under.</param>
public sealed record MyDayTaskSection(IReadOnlyList<MyDayTaskRow> Rows, MyDayCoverage Coverage, MyDayLimits Limits);

/// <summary>The habit rows and what the read could not establish about them.</summary>
/// <param name="Rows">The scheduled habits.</param>
/// <param name="Coverage">Whether <paramref name="Rows"/> is everything that qualifies.</param>
/// <param name="Limits">The ceilings this read ran under.</param>
public sealed record MyDayHabitSection(IReadOnlyList<MyDayHabitRow> Rows, MyDayCoverage Coverage, MyDayLimits Limits);

/// <summary>Whether a section is the whole answer.</summary>
/// <param name="Kind"><c>complete</c>, or <c>partial</c> when <paramref name="Reasons"/> is not empty.</param>
/// <param name="Reasons">Why the section may be missing rows. Zero rows plus a reason is not an empty day.</param>
public sealed record MyDayCoverage(string Kind, IReadOnlyList<MyDayCoverageReason> Reasons);

/// <summary>One stable reason a section is partial.</summary>
/// <param name="Code">
/// <c>candidate_limit</c>, <c>row_limit</c>, <c>invalid_schema</c>, <c>invalid_properties</c>,
/// <c>invalid_recurrence</c>, <c>habit_locked</c>, <c>invalid_habit</c> or <c>habit_history_limit</c>.
/// </param>
/// <param name="Omitted">How many rows it cost, or null when that cannot be known.</param>
public sealed record MyDayCoverageReason(string Code, int? Omitted);

/// <summary>The ceilings a section was read under.</summary>
/// <param name="Candidates">The most candidates considered.</param>
/// <param name="Rows">The most rows returned.</param>
public sealed record MyDayLimits(int Candidates, int Rows);

/// <summary>A task to show, naming the original item and the command that finishes it.</summary>
/// <param name="ItemId">The original item. With an occurrence action it is the series, never a copy.</param>
/// <param name="ContainerId">The item's parent, when visible.</param>
/// <param name="ContainerTitle">The parent's title, the row's source label.</param>
/// <param name="Title">The item's title.</param>
/// <param name="Section"><c>today</c>, <c>overdue</c> or <c>assigned</c>.</param>
/// <param name="DueDay">The due day, when the item has one.</param>
/// <param name="StartDay">The start day, when the item has one.</param>
/// <param name="Priority">1 (most urgent) to 4, when set.</param>
/// <param name="Estimate">The estimate, when set.</param>
/// <param name="Action">How to finish it. A hint, not a permission grant.</param>
public sealed record MyDayTaskRow(
    Guid ItemId,
    Guid? ContainerId,
    string? ContainerTitle,
    string Title,
    string Section,
    DateOnly? DueDay,
    DateOnly? StartDay,
    int? Priority,
    decimal? Estimate,
    MyDayTaskAction Action);

/// <summary>How to finish a task row.</summary>
/// <param name="Kind">
/// <c>property</c>: set <paramref name="Key"/> to true on the item. <c>occurrence</c>: complete the
/// series' occurrence on <paramref name="OccurredOn"/>.
/// </param>
/// <param name="Key">The completion property's key, for <c>property</c>.</param>
/// <param name="OccurredOn">The occurrence day, for <c>occurrence</c>.</param>
public sealed record MyDayTaskAction(string Kind, string? Key, DateOnly? OccurredOn);

/// <summary>A habit scheduled today, on the habit's own local day.</summary>
/// <param name="ItemId">The original habit item.</param>
/// <param name="ContainerId">The habit's parent, when visible.</param>
/// <param name="ContainerTitle">The parent's title, the row's source label.</param>
/// <param name="Title">The habit's title.</param>
/// <param name="Timezone">The habit's saved IANA zone, which decided <paramref name="Occurrence"/>'s date.</param>
/// <param name="Occurrence">
/// Today's occurrence in that zone. Check-ins and undo use its date unchanged, whatever the task day is.
/// </param>
public sealed record MyDayHabitRow(
    Guid ItemId,
    Guid? ContainerId,
    string? ContainerTitle,
    string Title,
    string Timezone,
    HabitOccurrence Occurrence);
