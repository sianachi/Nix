using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Nix.Abstractions.Workers;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace Nix.Persistence.RabbitMq;

/// <summary>Projects short-lived worker capability heartbeats into Core's live registry.</summary>
public sealed class RabbitCapabilityConsumer(
    IWorkerCapabilityRegistry registry,
    RabbitMqConnection connections,
    RabbitMqOptions options,
    TimeProvider clock,
    ILogger<RabbitCapabilityConsumer> logger) : BackgroundService
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
#pragma warning disable CA1031 // Justification: capability discovery must reconnect without stopping Core.
            catch (Exception exception)
            {
                RabbitMqLog.ConnectionFailed(logger, "capability consumer", exception);
                await Task.Delay(TimeSpan.FromSeconds(5), clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    private async Task ConsumeUntilDisconnectedAsync(CancellationToken cancellationToken)
    {
        var connection = await connections.OpenAsync("nix-api-capabilities", cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var channel = await connection.CreateChannelAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
            await using (channel.ConfigureAwait(false))
            {
                var subscription = await channel.QueueDeclareAsync(
                    queue: string.Empty,
                    durable: false,
                    exclusive: true,
                    autoDelete: true,
                    arguments: null,
                    passive: false,
                    noWait: false,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                await channel.QueueBindAsync(
                    subscription.QueueName,
                    RabbitMqNames.CapabilitiesExchange,
                    routingKey: "#",
                    arguments: null,
                    noWait: false,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                await channel.BasicQosAsync(0, options.Prefetch, false, cancellationToken).ConfigureAwait(false);
                var consumer = new AsyncEventingBasicConsumer(channel);
                consumer.ReceivedAsync += async (_, delivery) =>
                    await HandleAsync(channel, delivery, cancellationToken).ConfigureAwait(false);
                await channel.BasicConsumeAsync(
                    subscription.QueueName,
                    autoAck: false,
                    consumer,
                    cancellationToken).ConfigureAwait(false);
                while (!cancellationToken.IsCancellationRequested && connection.IsOpen && channel.IsOpen)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), clock, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }

    private async Task HandleAsync(
        IChannel channel,
        BasicDeliverEventArgs delivery,
        CancellationToken cancellationToken)
    {
        try
        {
            if (delivery.Body.Length > options.MaxMessageBytes)
            {
                await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, cancellationToken).ConfigureAwait(false);
                return;
            }
            var envelope = JsonSerializer.Deserialize(
                delivery.Body.Span,
                RabbitMqJsonContext.Default.WorkerCapabilityEnvelope);
            if (envelope is null || !TryMap(envelope, clock.GetUtcNow(), out var advertisement))
            {
                RabbitMqLog.InvalidResult(logger, "worker capability contract was invalid");
                await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, cancellationToken).ConfigureAwait(false);
                return;
            }
            registry.Replace(advertisement);
            await channel.BasicAckAsync(delivery.DeliveryTag, multiple: false, cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException exception)
        {
            RabbitMqLog.InvalidResult(logger, exception.Message);
            await channel.BasicRejectAsync(delivery.DeliveryTag, requeue: false, cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool TryMap(
        WorkerCapabilityEnvelope envelope,
        DateTimeOffset now,
        out WorkerCapabilityAdvertisement advertisement)
    {
        advertisement = default!;
        if (envelope.SchemaVersion != 1
            || envelope.MessageType != "worker.capabilities.v1"
            || string.IsNullOrWhiteSpace(envelope.InstanceId)
            || envelope.InstanceId.Length > 128
            || envelope.Role != "export"
            || envelope.OccurredAt > now.AddMinutes(1)
            || envelope.ExpiresAt <= now
            || envelope.ExpiresAt > now.AddMinutes(3)
            || envelope.ExportFormats is not { Count: > 0 and <= 16 })
        {
            return false;
        }
        var formats = new List<ExportFormatCapability>(envelope.ExportFormats.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var format in envelope.ExportFormats)
        {
            if (format is null
                || format.Format is null
                || format.Label is null
                || format.Extension is null
                || format.MediaType is null
                || format.DeclaredLoss is null
                || !seen.Add(format.Format)
                || !SafeToken(format.Format, 32, allowDash: true)
                || !SafeToken(format.Extension, 16, allowDash: false)
                || format.Format.Length is < 1 or > 32
                || format.Label.Length is < 1 or > 64
                || format.Extension.Length is < 1 or > 16
                || format.MediaType.Length is < 3 or > 128
                || !format.MediaType.Contains('/', StringComparison.Ordinal)
                || format.Label.Any(char.IsControl)
                || format.MediaType.Any(char.IsControl)
                || format.DeclaredLoss.Count > 32
                || format.DeclaredLoss.Any(loss => loss is null || loss.Length is < 1 or > 500 || loss.Any(char.IsControl)))
            {
                return false;
            }
            formats.Add(new ExportFormatCapability(
                format.Format,
                format.Label,
                format.Extension,
                format.MediaType,
                format.Lossless,
                format.DeclaredLoss));
        }
        advertisement = new WorkerCapabilityAdvertisement(
            envelope.InstanceId,
            envelope.Role,
            envelope.OccurredAt,
            envelope.ExpiresAt,
            formats);
        return true;
    }

    private static bool SafeToken(string value, int maximumLength, bool allowDash) =>
        value.Length is > 0
        && value.Length <= maximumLength
        && value.All(character => char.IsAsciiDigit(character)
            || character is >= 'a' and <= 'z'
            || (allowDash && character == '-'));
}
