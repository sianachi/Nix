namespace Nix.Persistence.RabbitMq;

/// <summary>Connection and bounded-delivery settings for the internal RabbitMQ transport.</summary>
public sealed class RabbitMqOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:RabbitMq";

    /// <summary>Gets or sets the AMQP URI. An empty value disables asynchronous dispatch.</summary>
    public Uri? Uri { get; set; }

    /// <summary>Gets or sets the queue from which Core consumes worker results.</summary>
    public string ResultsQueue { get; set; } = RabbitMqNames.ResultsQueue;

    /// <summary>Gets or sets the maximum accepted broker message size.</summary>
    public int MaxMessageBytes { get; set; } = 64 * 1024;

    /// <summary>Gets or sets the number of result deliveries Core may hold unacknowledged.</summary>
    public ushort Prefetch { get; set; } = 32;
}
