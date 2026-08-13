using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Calendar;

/// <summary>Reads every calendar in a workspace as one set of dated entries.</summary>
/// <param name="WorkspaceId">The workspace to read.</param>
/// <param name="From">The first day to include, as <c>yyyy-MM-dd</c>.</param>
/// <param name="To">The last day to include, as <c>yyyy-MM-dd</c>.</param>
public sealed record GetWorkspaceCalendar(WorkspaceId WorkspaceId, string From, string To)
    : IQuery<Result<WorkspaceCalendarResults>>;

/// <summary>What a calendar read found, and the ceiling it was read under.</summary>
/// <param name="Calendar">The entries, and the containers that placed nothing.</param>
/// <param name="EntryLimit">The entry ceiling that was applied.</param>
public sealed record WorkspaceCalendarResults(WorkspaceCalendar Calendar, int EntryLimit)
{
    /// <summary>Whether the entry ceiling was reached.</summary>
    public bool EntriesTruncated => Calendar.Entries.Count >= EntryLimit;
}

/// <summary>
/// Collates every calendar view in a workspace into one set of dated items.
/// </summary>
/// <remarks>
/// <para>
/// <b>One permission answer, used twice, and the second use is the one that matters.</b> The caller
/// must be able to read the workspace they named - otherwise this answers "an empty calendar",
/// which for a workspace identifier they guessed is still a statement about a workspace they may
/// not see. And the readable set goes on into the query, so the rows are filtered while they are
/// being chosen rather than after they have been read. Both come from one call, so the gate and the
/// filter cannot drift apart. The same shape <c>GetWorkspaceGraphHandler</c> uses, deliberately.
/// </para>
/// <para>
/// A workspace the caller may not read is reported as not found, matching every other read in the
/// product. "You may not see this" confirms the thing exists.
/// </para>
/// <para>
/// <b>Which property is a date is decided by the data, not by the caller.</b> A container's calendar
/// view names the property it places its children by, and different containers may name different
/// ones. There is no parameter to override that: a caller who could choose the property could ask
/// this endpoint to project any field of every item in the workspace, which is a different and much
/// larger disclosure than a calendar.
/// </para>
/// </remarks>
public sealed class GetWorkspaceCalendarHandler
    : IQueryHandler<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>
{
    /// <summary>
    /// The most entries one calendar read may return.
    /// </summary>
    /// <remarks>
    /// Two thousand, chosen against what a calendar can honestly show rather than what the database
    /// can return. A month grid holding two thousand entries is already sixty-five a day, well past
    /// the point where a cell shows a count instead of its contents - so a higher ceiling would buy
    /// a slower response nobody can read. It also bounds the payload: two thousand entries of
    /// identifier, title, container and value is a few hundred kilobytes of JSON, and the lists
    /// behind them stay inside the per-request allocation budget.
    /// </remarks>
    public const int MaximumEntries = 2_000;

    /// <summary>The widest window one read may ask for, in days.</summary>
    /// <remarks>
    /// A little over a year, so the ordinary asks - a month, a week, a day, or a year at a glance -
    /// all fit and an unbounded range does not. Without it a client could ask for every date the
    /// calendar supports and turn a windowed read back into a whole-workspace one, which is the
    /// thing the window exists to prevent.
    /// </remarks>
    public const int MaximumWindowDays = 400;

    private readonly IWorkspaceCalendar _calendar;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="GetWorkspaceCalendarHandler"/> class.</summary>
    /// <param name="calendar">Reads the dated entries.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public GetWorkspaceCalendarHandler(IWorkspaceCalendar calendar, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        ArgumentNullException.ThrowIfNull(permissions);

        _calendar = calendar;
        _permissions = permissions;
    }

    /// <summary>Reads the calendar.</summary>
    /// <param name="query">The workspace and the window.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The calendar, or why it could not be read.</returns>
    public async ValueTask<Result<WorkspaceCalendarResults>> HandleAsync(
        GetWorkspaceCalendar query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!TryReadWindow(query.From, query.To, out var window))
        {
            return Result.Failure<WorkspaceCalendarResults>(
                CalendarErrors.InvalidWindow(window));
        }

        var workspaces = await _permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!workspaces.Contains(query.WorkspaceId))
        {
            return Result.Failure<WorkspaceCalendarResults>(
                CalendarErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        var calendar = await _calendar
            .ReadAsync(query.WorkspaceId, workspaces, query.From, query.To, MaximumEntries, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new WorkspaceCalendarResults(calendar, MaximumEntries));
    }

    /// <summary>
    /// Whether the window is two real dates in the right order and inside the width bound.
    /// </summary>
    /// <param name="from">The first day.</param>
    /// <param name="to">The last day.</param>
    /// <param name="problem">Why it was refused, when it was.</param>
    /// <returns><see langword="true"/> when the window may be used.</returns>
    /// <remarks>
    /// <para>
    /// Parsed here rather than trusted, even though the values reach the statement as text and are
    /// only ever compared as text. Two reasons, and neither is injection - the parameter is bound.
    /// The first is that <c>2026-13-45</c> compares perfectly well as a string and would silently
    /// return nothing, which a reader would read as "nothing is scheduled". The second is that the
    /// width bound cannot be checked without knowing what the two values mean.
    /// </para>
    /// <para>
    /// <see cref="DateOnly.TryParseExact(string, string, out DateOnly)"/> with an exact format, so
    /// <c>2026-3-1</c> is refused rather than accepted and then compared against stored values that
    /// are always zero-padded - which would match nothing and look like an empty month.
    /// </para>
    /// </remarks>
    private static bool TryReadWindow(string from, string to, out string problem)
    {
        if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var first))
        {
            problem = $"'{from}' is not a date. Windows are given as yyyy-MM-dd.";
            return false;
        }

        if (!DateOnly.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var last))
        {
            problem = $"'{to}' is not a date. Windows are given as yyyy-MM-dd.";
            return false;
        }

        if (last < first)
        {
            problem = $"The window ends ({to}) before it begins ({from}).";
            return false;
        }

        var days = last.DayNumber - first.DayNumber + 1;
        if (days > MaximumWindowDays)
        {
            problem =
                $"The window covers {days.ToString(CultureInfo.InvariantCulture)} days, and the "
                + $"most one read may cover is {MaximumWindowDays.ToString(CultureInfo.InvariantCulture)}.";
            return false;
        }

        problem = string.Empty;
        return true;
    }
}

/// <summary>
/// Route handler for reading a workspace's collated calendar.
/// </summary>
internal static class GetWorkspaceCalendarEndpoint
{
    /// <summary>Handles a calendar request.</summary>
    /// <param name="workspaceId">The workspace to read.</param>
    /// <param name="from">The first day of the window.</param>
    /// <param name="to">The last day of the window.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The calendar.</returns>
    internal static async Task<Results<Ok<WorkspaceCalendarResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        string? from,
        string? to,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        // Absent is not the same as malformed, and both are the caller's mistake rather than ours.
        // Defaulting to "this month" would be a server guessing at a question, and a client that
        // forgot the parameter would get a plausible answer to something it did not ask.
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to))
        {
            return TypedResults.Problem(CalendarEndpoints.Problem(
                httpContext,
                CalendarErrors.InvalidWindow("Both 'from' and 'to' are required, as yyyy-MM-dd.")));
        }

        var result = await dispatcher
            .QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                new GetWorkspaceCalendar(WorkspaceId.From(workspaceId), from, to),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(CalendarEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        return TypedResults.Ok(new WorkspaceCalendarResponse(
            workspaceId,
            from,
            to,
            CalendarMapping.ToEntryResponses(found.Calendar.Entries),
            CalendarMapping.ToUnplaceableResponses(found.Calendar.Unplaceable),
            found.EntryLimit,
            found.EntriesTruncated));
    }
}
