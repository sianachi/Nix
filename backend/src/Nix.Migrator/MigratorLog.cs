using Microsoft.Extensions.Logging;

namespace Nix.Migrator;

/// <summary>
/// Structured log messages for the migration job. Source-generated so the job allocates nothing
/// per message and every field is a real structured property in the log pipeline.
/// </summary>
internal static partial class MigratorLog
{
    [LoggerMessage(
        EventId = 1000,
        Level = LogLevel.Information,
        Message = "Applying migrations to {Host}/{Database}.")]
    public static partial void Starting(ILogger logger, string host, string database);

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Connected as {Role}. {AlreadyPresentCount} migration(s) already applied, {PendingCount} pending.")]
    public static partial void Connected(ILogger logger, string role, int alreadyPresentCount, int pendingCount);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Information,
        Message = "Applied migration {Migration}.")]
    public static partial void Applied(ILogger logger, string migration);

    [LoggerMessage(
        EventId = 1003,
        Level = LogLevel.Information,
        Message = "Schema is up to date.")]
    public static partial void UpToDate(ILogger logger);

    [LoggerMessage(
        EventId = 1004,
        Level = LogLevel.Error,
        Message = "Migration failed. The schema is unchanged from the last completed migration; the rollout must not proceed.")]
    public static partial void Failed(ILogger logger, Exception exception);

    [LoggerMessage(
        EventId = 1005,
        Level = LogLevel.Error,
        Message = "No connection string. Set {EnvironmentVariable} or pass --{ConfigurationKey}=<value>.")]
    public static partial void MissingConnectionString(
        ILogger logger,
        string environmentVariable,
        string configurationKey);
}
