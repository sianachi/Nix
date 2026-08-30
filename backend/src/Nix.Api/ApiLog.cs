using System.Net;
using Microsoft.Extensions.Logging;

namespace Nix;

/// <summary>
/// Structured log messages for the API host. Source-generated, so a message costs no allocation
/// when its level is disabled and every field arrives as a real structured property.
/// </summary>
internal static partial class ApiLog
{
    [LoggerMessage(
        EventId = 2000,
        Level = LogLevel.Warning,
        Message = "No '{ConnectionStringName}' connection string is configured; persistence is not "
            + "registered and any request that needs a row will fail. Set "
            + "ConnectionStrings__{ConnectionStringName} to the runtime role (nix_app, never "
            + "nix_migrator).")]
    public static partial void PersistenceNotConfigured(ILogger logger, string connectionStringName);

    [LoggerMessage(
        EventId = 2001,
        Level = LogLevel.Warning,
        Message = "No '{SecretConfigurationKey}' is configured; the /internal surface refuses every "
            + "request. Set it to the same value as the collaboration service's "
            + "NIX_COLLAB_INTERNAL_SECRET to enable service-to-service calls.")]
    public static partial void InternalSurfaceDisabled(ILogger logger, string secretConfigurationKey);

    /// <summary>
    /// One line per refusal, so a client being throttled is visible here rather than only in that
    /// client's own report. The level is a parameter because the same event means different things
    /// at different times: a runaway client is routine, the first crossing of the
    /// failed-authentication window is a credential-guessing signal.
    /// </summary>
    /// <param name="logger">Where the line goes.</param>
    /// <param name="level">Warning for the first crossing of a limit, Information for what follows.</param>
    /// <param name="limiter">Which limiter refused - the rate-limit policy, or the auth throttle.</param>
    /// <param name="clientKey">The address the limiter partitions on. Never a token or a body.</param>
    /// <param name="requestPath">The path refused.</param>
    /// <param name="retryAfterSeconds">What the client was told to wait.</param>
    [LoggerMessage(
        EventId = 2002,
        Message = "Rate limit '{Limiter}' refused {ClientKey} on {RequestPath}; retry after "
            + "{RetryAfterSeconds}s.")]
    public static partial void RateLimitRefused(
        ILogger logger,
        LogLevel level,
        string limiter,
        IPAddress clientKey,
        string requestPath,
        long retryAfterSeconds);

    /// <summary>
    /// The credential-guessing signal, logged once per crossing rather than once per refused
    /// request: the refusals that follow are the same fact and go out at Information.
    /// </summary>
    /// <param name="logger">Where the line goes.</param>
    /// <param name="clientKey">The address that reached the limit. Never a token or a body.</param>
    /// <param name="requestPath">The path the crossing failure was aimed at.</param>
    /// <param name="windowSeconds">How long the client stays refused.</param>
    [LoggerMessage(
        EventId = 2004,
        Level = LogLevel.Warning,
        Message = "Client {ClientKey} reached the failed-authentication limit on {RequestPath}; "
            + "requests presenting a token are refused for the next {WindowSeconds}s.")]
    public static partial void FailedAuthenticationLimitReached(
        ILogger logger,
        IPAddress clientKey,
        string requestPath,
        long windowSeconds);

    [LoggerMessage(
        EventId = 2003,
        Level = LogLevel.Information,
        Message = "Refused an oversized request body on {RequestPath} from {ClientKey}.")]
    public static partial void RequestBodyTooLarge(ILogger logger, string requestPath, IPAddress clientKey);

    [LoggerMessage(
        EventId = 2005,
        Level = LogLevel.Warning,
        Message = "First-login provisioning was unavailable on {RequestPath} at {Category} for provider "
            + "{ProviderId}; no provider response or token data was logged.")]
    public static partial void ProvisioningUnavailable(
        ILogger logger,
        string requestPath,
        string category,
        string providerId);

    [LoggerMessage(
        EventId = 2006,
        Level = LogLevel.Warning,
        Message = "First-login JIT admission was refused on {RequestPath} at {Reason} for provider "
            + "{ProviderId}; no token or claim data was logged.")]
    public static partial void JitAdmissionRefused(
        ILogger logger,
        string requestPath,
        string reason,
        string providerId);
}
