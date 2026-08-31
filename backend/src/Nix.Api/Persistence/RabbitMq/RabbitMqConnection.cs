using RabbitMQ.Client;

namespace Nix.Persistence.RabbitMq;

/// <summary>Builds recoverable RabbitMQ connections without declaring deployment topology.</summary>
public sealed class RabbitMqConnection(RabbitMqOptions options)
{
    public async ValueTask<IConnection> OpenAsync(string clientName, CancellationToken cancellationToken)
    {
        var uri = options.Uri;
        if (uri is null || !uri.IsAbsoluteUri || uri.Scheme is not ("amqp" or "amqps"))
        {
            throw new InvalidOperationException("Nix:RabbitMq:Uri must be an absolute amqp or amqps URI.");
        }

        var factory = new ConnectionFactory
        {
            Uri = uri,
            ClientProvidedName = clientName,
            AutomaticRecoveryEnabled = true,
            TopologyRecoveryEnabled = false,
            NetworkRecoveryInterval = TimeSpan.FromSeconds(5),
            RequestedHeartbeat = TimeSpan.FromSeconds(30),
            ConsumerDispatchConcurrency = 1,
            MaxInboundMessageBodySize = (uint)options.MaxMessageBytes,
        };
        return await factory.CreateConnectionAsync(cancellationToken).ConfigureAwait(false);
    }
}
