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
}
