using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Nix.Abstractions.Workers;
using RabbitMQ.Client;

namespace Nix.Persistence.RabbitMq;

/// <summary>Publishes the durable Postgres outbox with broker confirms.</summary>
public sealed class RabbitOutboxPublisher(
    IWorkerDispatchStore store,
    RabbitMqConnection connections,
    RabbitMqOptions options,
    TimeProvider clock,
    ILogger<RabbitOutboxPublisher> logger) : BackgroundService
{
    private readonly string owner = $"rabbit-publisher:{Environment.MachineName}:{Environment.ProcessId}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PublishUntilDisconnectedAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: a hosted transport loop must retain durable work and reconnect after any broker/client failure.
            catch (Exception exception)
            {
                RabbitMqLog.ConnectionFailed(logger, "publisher", exception);
                await DelayAfterFailureAsync(stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    private async Task PublishUntilDisconnectedAsync(CancellationToken cancellationToken)
    {
        var connection = await connections.OpenAsync("nix-api-outbox", cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var channelOptions = new CreateChannelOptions(
                publisherConfirmationsEnabled: true,
                publisherConfirmationTrackingEnabled: true,
                outstandingPublisherConfirmationsRateLimiter: null,
                consumerDispatchConcurrency: null);
            var channel = await connection.CreateChannelAsync(channelOptions, cancellationToken).ConfigureAwait(false);
            await using (channel.ConfigureAwait(false))
            {
                while (!cancellationToken.IsCancellationRequested && connection.IsOpen && channel.IsOpen)
                {
                    var events = await store.LeaseOutboxAsync(null, owner, 100, 30, cancellationToken).ConfigureAwait(false);
                    if (events.Count == 0)
                    {
                        await Task.Delay(TimeSpan.FromMilliseconds(500), clock, cancellationToken).ConfigureAwait(false);
                        continue;
                    }

                    foreach (var outboxEvent in events)
                    {
                        await PublishOneAsync(channel, outboxEvent, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
        }
    }

    private async Task PublishOneAsync(
        IChannel channel,
        DispatchedOutboxEvent outboxEvent,
        CancellationToken cancellationToken)
    {
        try
        {
            var route = RabbitMqRoute.For(outboxEvent);
            using var payloadDocument = JsonDocument.Parse(
                outboxEvent.Payload,
                new JsonDocumentOptions { MaxDepth = 8 });
            var envelope = new RabbitMessageEnvelope(
                1,
                outboxEvent.Id,
                route.MessageType,
                clock.GetUtcNow(),
                outboxEvent.TenantId,
                outboxEvent.WorkspaceId,
                outboxEvent.ItemId,
                route.Kind,
                payloadDocument.RootElement.Clone(),
                route.CorrelationId,
                TraceParent: Activity.Current?.Id);
            // byte[]: RabbitMQ.Client publishes ReadOnlyMemory<byte>; source generation bounds this below 64 KiB.
            var body = JsonSerializer.SerializeToUtf8Bytes(envelope, RabbitMqJsonContext.Default.RabbitMessageEnvelope);
            if (body.Length > options.MaxMessageBytes)
            {
                throw new InvalidOperationException("The durable outbox message exceeds the RabbitMQ envelope limit.");
            }

            var properties = new BasicProperties
            {
                Persistent = true,
                ContentType = "application/json",
                ContentEncoding = "utf-8",
                MessageId = outboxEvent.Id.ToString("D"),
                CorrelationId = route.CorrelationId,
                Type = route.MessageType,
                Timestamp = new AmqpTimestamp(envelope.OccurredAt.ToUnixTimeSeconds()),
                AppId = "nix-api",
            };
            await channel.BasicPublishAsync(
                route.Exchange,
                route.RoutingKey,
                mandatory: true,
                properties,
                body,
                cancellationToken).ConfigureAwait(false);
            if (!await store.FinishOutboxAsync(outboxEvent.Id, owner, true, null, cancellationToken).ConfigureAwait(false))
            {
                RabbitMqLog.OutboxLeaseLost(logger, outboxEvent.Id);
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            var failure = exception.Message.Length <= 2000 ? exception.Message : exception.Message[..2000];
            await store.FinishOutboxAsync(outboxEvent.Id, owner, false, failure, cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

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

public sealed record RabbitMqRoute(string Exchange, string RoutingKey, string MessageType, string Kind, string CorrelationId)
{
    public static RabbitMqRoute For(DispatchedOutboxEvent outboxEvent)
    {
        ArgumentNullException.ThrowIfNull(outboxEvent);
        if (outboxEvent.Kind == RabbitMqNames.WorkerCommandKind)
        {
            using var document = JsonDocument.Parse(outboxEvent.Payload, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (!root.TryGetProperty("jobId", out var jobIdValue)
                || !jobIdValue.TryGetGuid(out var jobId)
                || !root.TryGetProperty("kind", out var kindValue)
                || kindValue.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(kindValue.GetString()))
            {
                throw new InvalidOperationException("The worker command outbox payload is invalid.");
            }
            var kind = kindValue.GetString()!;
            return new RabbitMqRoute(
                RabbitMqNames.CommandsExchange,
                kind,
                "worker.command.v1",
                kind,
                jobId.ToString("D"));
        }

        return new RabbitMqRoute(
            RabbitMqNames.WorkspaceExchange,
            outboxEvent.Kind,
            "workspace.event.v1",
            outboxEvent.Kind,
            outboxEvent.Id.ToString("D"));
    }
}
