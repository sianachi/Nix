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
}
