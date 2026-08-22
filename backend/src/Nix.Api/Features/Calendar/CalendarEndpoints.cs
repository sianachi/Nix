using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.Calendar;

/// <summary>
/// Route registration for the calendar feature: every calendar in one workspace, collated.
/// </summary>
/// <remarks>
/// Its own feature rather than a shape on the graph route, even though both are workspace-wide
/// reads. A graph answers "what is in here and how is it joined up" and is drawn whole; a calendar
/// answers "what is in this window", and the window is the difference that matters. Hung off the
/// graph, the ceiling would truncate by tree position - so a workspace over the cap would show a
/// month that was wrong rather than a month that was short, and nothing in the payload could say
/// which.
/// </remarks>
internal static class CalendarEndpoints
{
    /// <summary>Stable code for "no such workspace, or the caller cannot see it".</summary>
    /// <remarks>
    /// The same literal the workspaces feature publishes. Spelled out rather than referenced so
    /// this feature owns its own contract, and asserted equal to the workspaces feature's code by
    /// test, which is the check a shared reference would only have looked like.
    /// </remarks>
    internal const string WorkspaceNotFoundCode = "workspaces.not_found";

    /// <summary>Stable code for a window that is not two ordered dates.</summary>
    internal const string InvalidWindowCode = "calendar.invalid_window";

    /// <summary>
    /// Registers the calendar feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapCalendarEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var workspaces = endpoints.MapGroup("/api/v1/workspaces").WithTags("Calendar");

        workspaces.MapGet("/{workspaceId:guid}/calendar", GetWorkspaceCalendarEndpoint.Handle)
            .WithName("GetWorkspaceCalendar")
            .WithSummary("Every calendar in a workspace, collated into one window")
            .WithDescription(
                "Returns the dated items of one workspace between 'from' and 'to' inclusive, both "
                + "given as yyyy-MM-dd and both required. "
                + "Which property carries an item's date is decided by the data rather than by the "
                + "caller: a container's calendar view names the property its children are placed "
                + "by, and different containers may name different ones, so every entry carries the "
                + "key it was placed by and the container that decided it. A container configuring "
                + "more than one calendar view contributes each item once, through the first view "
                + "it declares. "
                + "Values are returned exactly as stored - either yyyy-MM-dd or an RFC 9557 "
                + "timestamp with a bracketed zone - and 'kind' says which. They are deliberately "
                + "not normalised: only the reader's own zone decides which day a moment falls on, "
                + "so the window here is coarse and the client places precisely. An entry near a "
                + "window edge may therefore fall on a different day for the reader. "
                + "Only items the caller may read are included, and they are excluded while the "
                + "query runs rather than filtered out of its results. "
                + "Containers that offer a calendar but name no property to place by are reported "
                + "in 'unplaceable' rather than passed over in silence, because a reader with no "
                + "way to tell 'nothing is scheduled' from 'that one could not be read' will "
                + "believe the first. So are repeating items whose series cannot be drawn on this "
                + "calendar - by container ('calendar_not_by_due_date'), by the item itself "
                + "('no_due_date'), or by the stored rule ('unreadable_rule'). That list is never "
                + "truncated. "
                + "An entry produced by a recurrence rule rather than read from storage carries "
                + "'generated: true' and its own 'completed' state; a client must not offer to "
                + "edit or delete it as if it were a stored item, since there is no row behind it, "
                + "only the series that produced it. "
                + "Entries are bounded at "
                + EntryCeiling
                + "; when the ceiling is reached 'entriesTruncated' is true and the window holds "
                + "more than this response carries, which a calendar cannot convey on its own. "
                + "Entries enter earliest first, so a truncated read keeps the start of the window. "
                + "Separately, 'seriesTruncated' is true when more repeating series exist than "
                + "this read considered or than there was room left to expand after concrete "
                + "entries were read - a different fact from 'entriesTruncated', since a workspace "
                + "can hold more series than this response even names. "
                + "The window may cover at most "
                + WindowCeiling
                + " days. "
                + "A workspace the caller may not see is reported as not found rather than as "
                + "forbidden, so the response cannot be used to confirm that it exists.")
            .Produces<WorkspaceCalendarResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Total over the codes this feature can raise, and 500 for anything else. A default of 404
    /// would be the worst possible one: a code added to <see cref="CalendarErrors"/> and forgotten
    /// here would reach clients as the one status they already handle, carrying a message about
    /// something else entirely.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            WorkspaceNotFoundCode => StatusCodes.Status404NotFound,
            InvalidWindowCode => StatusCodes.Status400BadRequest,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    /// <summary>The entry ceiling as the published description spells it.</summary>
    /// <remarks>
    /// Read off the handler rather than typed, so raising the ceiling cannot leave the contract
    /// describing the old one.
    /// </remarks>
    private static string EntryCeiling =>
        GetWorkspaceCalendarHandler.MaximumEntries.ToString("N0", CultureInfo.InvariantCulture);

    /// <summary>The window width bound as the published description spells it.</summary>
    private static string WindowCeiling =>
        GetWorkspaceCalendarHandler.MaximumWindowDays.ToString("N0", CultureInfo.InvariantCulture);
}
