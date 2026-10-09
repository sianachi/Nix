using Nix.Domain.Primitives;

namespace Nix.Features.Query;

/// <summary>
/// The expected failures of the query feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// Declared once here rather than constructed at call sites, because the code is the part clients
/// branch on. The literals live on <see cref="QueryEndpoints"/>, where the status mapping reads
/// them, so the guarantee does not depend on two files agreeing about a string.
/// </remarks>
public static class QueryErrors
{
    /// <summary>The today parameter was missing or not a day.</summary>
    /// <remarks>
    /// A client fault, so 400 - and kept apart from not-found, because a typo in a date must not
    /// look like a permission problem. Never defaulted to the server's own day: only the caller's
    /// zone decides which day today is, and a wrong guess here moves every relative rule.
    /// </remarks>
    public static NixError InvalidToday(string detail) =>
        new(QueryEndpoints.InvalidTodayCode, detail);

    /// <summary>The item has no such query view.</summary>
    /// <remarks>
    /// Covers both "no view with that id" and "a view with that id that is not a query" - the
    /// detail tells them apart, the status does not need to. 404: the caller addressed a resource
    /// that is not there.
    /// </remarks>
    public static NixError ViewNotFound(string detail) =>
        new(QueryEndpoints.ViewNotFoundCode, detail);

    /// <summary>The stored rules no longer pass validation, so the query was not run.</summary>
    /// <remarks>
    /// The fail-closed line: the stored-JSON reader drops a malformed rule fail-soft, and a
    /// dropped rule can only widen a query - so a set that no longer validates refuses to run
    /// rather than silently disclosing more than the saved query asked for. 422: the resource
    /// exists, its state cannot be processed.
    /// </remarks>
    public static NixError InvalidRules(string detail) =>
        new(QueryEndpoints.InvalidRulesCode, detail);

    /// <summary>An ad-hoc query or aggregate asked for something its grammar does not allow.</summary>
    /// <remarks>
    /// 400, kept apart from <see cref="InvalidRules"/> (422): there the rules were stored and have
    /// stopped validating, here the caller sent them and can correct them. Checked before anything
    /// is read, so the refusal is a function of the request alone and says nothing about the data.
    /// </remarks>
    public static NixError InvalidRequest(string detail) =>
        new(QueryEndpoints.InvalidRequestCode, detail);

    /// <summary>The query ran past its statement timeout.</summary>
    /// <remarks>503: the request was sound and may succeed later, or narrower.</remarks>
    public static NixError TimedOut(string detail) =>
        new(QueryEndpoints.TimedOutCode, detail);

    /// <summary>The database refused to finish the query on the data it met.</summary>
    /// <remarks>
    /// 503 rather than a 500: the rules were valid, so this is a fault in what is stored, which the
    /// caller can report but not correct by resending. Never expected - every cast is guarded - and
    /// logged by the handler when it happens.
    /// </remarks>
    public static NixError CouldNotRun(string detail) =>
        new(QueryEndpoints.CouldNotRunCode, detail);

    /// <summary>The caller already has as many ad-hoc queries running as one principal may.</summary>
    public static NixError TooManyInFlight(string detail) =>
        new(QueryEndpoints.TooManyInFlightCode, detail);

    /// <summary>Maps a query port failure onto its stable error.</summary>
    /// <param name="failure">The port's failure.</param>
    /// <returns>The error the response carries.</returns>
    public static NixError From(Nix.Abstractions.ItemQueryFailedException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);
        return failure.TimedOut
            ? TimedOut("The query took too long. Narrow it - a scope, a date window, fewer groups - and try again.")
            : CouldNotRun("The query could not run on the stored data. Try again, or report it if it keeps happening.");
    }
}
