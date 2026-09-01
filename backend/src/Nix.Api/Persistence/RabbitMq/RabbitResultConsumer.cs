using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Nix.Abstractions.Workers;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace Nix.Persistence.RabbitMq;

/// <summary>Applies idempotent worker results and acknowledges them only after Postgres accepts them.</summary>
public sealed class RabbitResultConsumer(
    IWorkerDispatchStore store,
    RabbitMqConnection connections,
    RabbitMqOptions options,
    TimeProvider clock,
    ILogger<RabbitResultConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ConsumeUntilDisconnectedAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: a hosted transport loop must reconnect after any broker/client failure without stopping Core.
            catch (Exception exception)
            {
                RabbitMqLog.ConnectionFailed(logger, "result consumer", exception);
                await DelayAfterFailureAsync(stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    private async Task ConsumeUntilDisconnectedAsync(CancellationToken cancellationToken)
    {
        var connection = await connections.OpenAsync("nix-api-results", cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var channel = await connection.CreateChannelAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
            await using (channel.ConfigureAwait(false))
            {
                await channel.BasicQosAsync(0, options.Prefetch, false, cancellationToken).ConfigureAwait(false);
                var consumer = new AsyncEventingBasicConsumer(channel);
                consumer.ReceivedAsync += async (_, delivery) =>
                    await HandleAsync(channel, delivery, cancellationToken).ConfigureAwait(false);
                await channel.BasicConsumeAsync(options.ResultsQueue, autoAck: false, consumer, cancellationToken).ConfigureAwait(false);
                while (!cancellationToken.IsCancellationRequested && connection.IsOpen && channel.IsOpen)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), clock, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }

    private async Task HandleAsync(IChannel channel, BasicDeliverEventArgs delivery, CancellationToken hostToken)
    {
        try
        {
            if (delivery.Body.Length > options.MaxMessageBytes)
            {
                RabbitMqLog.InvalidResult(logger, "message exceeded the configured limit");
                await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, hostToken).ConfigureAwait(false);
                return;
            }
            var result = JsonSerializer.Deserialize(
                delivery.Body.Span,
                RabbitMqJsonContext.Default.WorkerResultEnvelope);
            if (result is null || !IsValid(result))
            {
                RabbitMqLog.InvalidResult(logger, "message contract was invalid");
                await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, hostToken).ConfigureAwait(false);
                return;
            }

            await ApplyResultAsync(store, result, hostToken).ConfigureAwait(false);
            await channel.BasicAckAsync(delivery.DeliveryTag, multiple: false, hostToken).ConfigureAwait(false);
        }
        catch (JsonException exception)
        {
            RabbitMqLog.InvalidResult(logger, exception.Message);
            await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, hostToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (hostToken.IsCancellationRequested)
        {
            // Closing the channel requeues an unacknowledged delivery.
        }
#pragma warning disable CA1031 // Justification: an unacknowledged result must be requeued after any transient application or broker failure.
        catch (Exception exception)
        {
            RabbitMqLog.ResultApplyFailed(logger, exception);
            await channel.BasicNackAsync(delivery.DeliveryTag, multiple: false, requeue: true, hostToken).ConfigureAwait(false);
        }
#pragma warning restore CA1031
    }

    /// <summary>Applies one result and makes required export cleanup durable before acknowledgement.</summary>
    public static async ValueTask<WorkerResultApplication> ApplyResultAsync(
        IWorkerDispatchStore dispatch,
        WorkerResultEnvelope result,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(dispatch);
        ArgumentNullException.ThrowIfNull(result);
        var application = await dispatch.ApplyResultAsync(
            result.JobId,
            result.ExecutionId,
            result.Succeeded,
            result.Retryable,
            result.Result?.GetRawText(),
            result.ErrorCode,
            result.ErrorDetail,
            cancellationToken).ConfigureAwait(false);

        switch (application.Outcome)
        {
            case WorkerResultApplicationOutcome.Completed:
            case WorkerResultApplicationOutcome.RetryScheduled:
            case WorkerResultApplicationOutcome.Failed:
            case WorkerResultApplicationOutcome.Cancelled:
            case WorkerResultApplicationOutcome.InvalidExportResult:
            case WorkerResultApplicationOutcome.AlreadyCompleted:
            case WorkerResultApplicationOutcome.AlreadyTerminal:
            case WorkerResultApplicationOutcome.StaleExecution:
            case WorkerResultApplicationOutcome.NotFound:
                break;
            case WorkerResultApplicationOutcome.InvalidRequest:
            default:
                throw new InvalidOperationException("The worker result could not be applied safely.");
        }

        if (!application.RequiresExportCleanup)
        {
            return application;
        }
        if (!result.Succeeded
            || application.Outcome is not (WorkerResultApplicationOutcome.Completed
                or WorkerResultApplicationOutcome.AlreadyCompleted))
        {
            throw new InvalidOperationException("The worker result requested cleanup in an invalid state.");
        }

        // A redelivery after completion repairs a cleanup transaction that was interrupted by an
        // API or database outage. The Rabbit delivery is not acknowledged until this is durable.
        if (!await dispatch.ScheduleExportCleanupAsync(result.JobId, cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The completed export cleanup could not be scheduled.");
        }
        return application;
    }

    /// <summary>Validates the bounded, transport-level worker result contract.</summary>
    public static bool IsValid(WorkerResultEnvelope result) =>
        result is
        {
            SchemaVersion: 1,
            MessageType: "worker.result.v1",
            MessageId: var messageId,
            JobId: var jobId,
            ExecutionId.Length: > 0 and <= 128,
        }
        && messageId != Guid.Empty
        && jobId != Guid.Empty
        && result.OccurredAt != default
        && !string.IsNullOrWhiteSpace(result.ExecutionId)
        && string.Equals(result.ExecutionId, result.ExecutionId.Trim(), StringComparison.Ordinal)
        && !result.ExecutionId.Any(char.IsControl)
        && (result.TraceParent is null
            || result.TraceParent is { Length: > 0 and <= 512 }
                && !result.TraceParent.Any(char.IsControl))
        && (result.Succeeded
            || result.Result is null
                && ValidErrorCode(result.ErrorCode)
                && result.ErrorDetail is { Length: > 0 and <= 2000 }
                && !string.IsNullOrWhiteSpace(result.ErrorDetail));

    private static bool ValidErrorCode(string? value) =>
        value is { Length: > 0 and <= 64 }
        && value.All(character => char.IsAsciiLetterOrDigit(character)
            || character is '_' or '-' or '.');

    private async Task DelayAfterFailureAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), clock, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Host shutdown interrupts backoff.
        }
    }
}
