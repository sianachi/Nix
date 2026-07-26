using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace Nix.Api.Errors;

/// <summary>
/// Single factory for every RFC 9457 problem-details response the API emits.
/// </summary>
/// <remarks>
/// <para>
/// The wire shape is RFC 9457 (<c>type</c>, <c>title</c>, <c>status</c>,
/// <c>detail</c>, <c>instance</c>) plus two extension members that are part of
/// the contract, not decoration:
/// </para>
/// <list type="bullet">
///   <item><description><c>code</c> — a stable, machine-readable identifier the
///   frontend switches on. Never derived from a message string, never localized,
///   never renamed without an OpenAPI breaking-change review.</description></item>
///   <item><description><c>traceId</c> — the current activity id, so a user-visible
///   failure can be joined to a trace.</description></item>
/// </list>
/// <para>
/// Two code paths produce problem details and both end here: endpoints returning
/// a typed failure call <see cref="Create"/>, while framework-produced problems
/// (unmatched route, unhandled exception) are completed by <see cref="Enrich"/>
/// from <c>ProblemDetailsOptions.CustomizeProblemDetails</c>. Minimal API
/// <c>TypedResults.Problem</c> writes its payload directly instead of routing
/// through <c>IProblemDetailsService</c>, so the enrichment cannot live in only
/// one of the two places. The RFC <c>type</c> and default <c>title</c> are left
/// to the framework, which applies them for both paths.
/// </para>
/// <para>
/// <c>ProblemDetails</c> lives in <c>Microsoft.AspNetCore.Mvc</c> but is not
/// controller infrastructure; the type is explicitly allowed while MVC
/// controllers are prohibited (engineering plan section 2.3).
/// </para>
/// </remarks>
internal static class ApiProblem
{
    /// <summary>Extension member carrying the stable machine-readable error code.</summary>
    internal const string CodeExtension = "code";

    /// <summary>Extension member carrying the correlating trace identifier.</summary>
    internal const string TraceIdExtension = "traceId";

    /// <summary>
    /// Fallback code for problems the framework produced without a feature-owned
    /// code (an unmatched route, an unhandled exception). Clients must not branch
    /// on it beyond "unexpected"; it exists so <c>code</c> is never absent.
    /// </summary>
    internal const string UnexpectedCode = "api.unexpected_error";

    /// <summary>
    /// Builds a problem-details payload with the stable <paramref name="code"/> and
    /// the standard extensions applied.
    /// </summary>
    /// <param name="httpContext">Request context, used for <c>instance</c> and trace correlation.</param>
    /// <param name="status">HTTP status code of the failure.</param>
    /// <param name="code">Stable machine-readable code, owned by the feature that fails.</param>
    /// <param name="title">Short, non-localized summary of the failure class.</param>
    /// <param name="detail">Human-readable explanation of this specific occurrence.</param>
    internal static ProblemDetails Create(
        HttpContext httpContext,
        int status,
        string code,
        string title,
        string detail)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentException.ThrowIfNullOrWhiteSpace(code);

        var problem = new ProblemDetails
        {
            Status = status,
            Title = title,
            Detail = detail,
        };

        problem.Extensions[CodeExtension] = code;
        Enrich(problem, httpContext);
        return problem;
    }

    /// <summary>
    /// Applies the invariants every problem response must satisfy: an
    /// <c>instance</c> pointing at the failed request, a <c>code</c>, and a
    /// <c>traceId</c>. Safe to call on a payload that already carries a code — an
    /// existing code is never overwritten.
    /// </summary>
    internal static void Enrich(ProblemDetails problem, HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(problem);
        ArgumentNullException.ThrowIfNull(httpContext);

        problem.Instance ??= httpContext.Request.Path.Value;

        if (!problem.Extensions.ContainsKey(CodeExtension))
        {
            problem.Extensions[CodeExtension] = UnexpectedCode;
        }

        problem.Extensions[TraceIdExtension] = Activity.Current?.Id ?? httpContext.TraceIdentifier;
    }
}
