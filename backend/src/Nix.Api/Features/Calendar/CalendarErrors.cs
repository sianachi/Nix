using Nix.Domain.Primitives;

namespace Nix.Features.Calendar;

/// <summary>
/// The expected failures of the calendar feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// Declared once here rather than constructed at each call site, because the code is the part
/// clients branch on. The literals live on <see cref="CalendarEndpoints"/>, which is where the
/// status mapping reads them, so the guarantee this class exists to give does not depend on two
/// files agreeing about a string.
/// </remarks>
public static class CalendarErrors
{
    /// <summary>No such workspace, or the caller cannot see it.</summary>
    /// <remarks>
    /// Deliberately the same code the workspaces feature uses. Asking for a workspace's calendar is
    /// asking for a workspace, and a client that already handles "that workspace is not visible"
    /// should not need a second branch because the fact arrived through a different route.
    /// </remarks>
    public static NixError WorkspaceNotFound(string detail) =>
        new(CalendarEndpoints.WorkspaceNotFoundCode, detail);

    /// <summary>The window was not two dates, or ended before it began.</summary>
    /// <remarks>
    /// A client fault rather than a refusal, so it answers 400. Kept apart from the not-found code
    /// because conflating them would make a typo in a date look like a permission problem - the
    /// exact confusion the graph client had to be taught to tell apart, and it cost a debugging
    /// session to find.
    /// </remarks>
    public static NixError InvalidWindow(string detail) =>
        new(CalendarEndpoints.InvalidWindowCode, detail);
}
