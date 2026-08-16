using System.Globalization;
using Microsoft.Extensions.Logging;
using Nix.Errors;

namespace Nix.Http;

/// <summary>
/// The one way a rate-limited request is refused, whichever limiter refused it.
/// </summary>
/// <remarks>
/// <para>
/// Both refusal paths end here - the ASP.NET rate limiter's <c>OnRejected</c> for the write
/// surfaces, and <see cref="Nix.Authentication.NixUnitOfWorkMiddleware"/>'s failed-authentication
/// throttle - so a client sees one shape: RFC 9457 problem details with the stable
/// <see cref="Code"/> and a <c>Retry-After</c> header it can act on.
/// </para>
/// <para>
/// The log line is written here rather than at each call site so no future limiter can refuse
/// silently: without it, the only evidence a client is being refused is that client's own report.
/// </para>
/// </remarks>
public static class RateLimitRefusal
{
    /// <summary>Stable code for a request refused because its source is over a rate limit.</summary>
    public const string Code = "request.rate_limited";

    /// <summary>Name of the rate-limiter policy applied to every mutating endpoint.</summary>
    public const string WritesPolicyName = "writes";

    /// <summary>Name of the limiter partitioned by public-form link and client address.</summary>
    public const string PublicFormsPolicyName = "public-forms";

    /// <summary>Name the failed-authentication throttle is logged under.</summary>
    public const string FailedAuthenticationLimiterName = "failed-authentication";

    /// <summary>Writes the 429 problem-details refusal with a <c>Retry-After</c> header, and logs it.</summary>
    /// <param name="context">The request being refused.</param>
    /// <param name="logger">Where the refusal is recorded.</param>
    /// <param name="limiter">Which limiter refused, so the line says what tripped.</param>
    /// <param name="retryAfter">How long the client should wait; rounded up to whole seconds, never below one.</param>
    /// <param name="level">
    /// Warning for the first crossing of a limit, Information for the refusals that follow, so a
    /// scan does not flood the log with the same fact.
    /// </param>
    /// <param name="cancellationToken">Cancelled when the client goes away.</param>
    /// <returns>A task that completes when the refusal has been written.</returns>
    public static async Task WriteAsync(
        HttpContext context,
        ILogger logger,
        string limiter,
        TimeSpan retryAfter,
        LogLevel level,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(logger);

        var seconds = Math.Max(1L, (long)Math.Ceiling(retryAfter.TotalSeconds));

        ApiLog.RateLimitRefused(
            logger,
            level,
            limiter,
            ClientKey.For(context),
            context.Request.Path.Value ?? string.Empty,
            seconds);

        context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        context.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);

        var problem = ApiProblem.Create(
            context,
            StatusCodes.Status429TooManyRequests,
            Code,
            "Too many requests",
            "The request was refused to protect the service. Retry after the interval in the Retry-After header.");

        // The content type rides the write call: the two-argument WriteAsJsonAsync overload stamps
        // application/json over anything set on the response beforehand.
        await context.Response
            .WriteAsJsonAsync(problem, options: null, "application/problem+json", cancellationToken)
            .ConfigureAwait(false);
    }
}
