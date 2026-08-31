using Microsoft.Extensions.Logging;

namespace Nix.Persistence.RabbitMq;

internal static partial class RabbitMqLog
{
    [LoggerMessage(2100, LogLevel.Warning, "RabbitMQ {role} connection failed; durable work remains queued")]
    public static partial void ConnectionFailed(ILogger logger, string role, Exception exception);

    [LoggerMessage(2101, LogLevel.Warning, "RabbitMQ outbox lease was lost after publishing message {messageId}")]
    public static partial void OutboxLeaseLost(ILogger logger, Guid messageId);

    [LoggerMessage(2102, LogLevel.Warning, "RabbitMQ worker result was rejected: {reason}")]
    public static partial void InvalidResult(ILogger logger, string reason);

    [LoggerMessage(2103, LogLevel.Error, "RabbitMQ worker result could not be applied; delivery will be retried")]
    public static partial void ResultApplyFailed(ILogger logger, Exception exception);
}
