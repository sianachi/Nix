using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions.Workers;

namespace Nix.Persistence.RabbitMq;

/// <summary>Registers RabbitMQ transport only when both persistence and a broker URI exist.</summary>
public static class RabbitMqServiceCollectionExtensions
{
    public static IServiceCollection AddNixRabbitMq(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        services.TryAddSingleton<IWorkerCapabilityRegistry, WorkerCapabilityRegistry>();
        var options = new RabbitMqOptions();
        configuration.GetSection(RabbitMqOptions.SectionName).Bind(options);
        if (options.Uri is null)
        {
            return services;
        }
        if (!options.Uri.IsAbsoluteUri || options.Uri.Scheme is not ("amqp" or "amqps"))
        {
            throw new InvalidOperationException("Nix:RabbitMq:Uri must be an absolute amqp or amqps URI.");
        }
        if (options.MaxMessageBytes is <= 0 or > 64 * 1024 || options.Prefetch is 0 or > 256)
        {
            throw new InvalidOperationException("RabbitMQ limits are outside the supported bounds.");
        }

        services.AddSingleton(options);
        services.AddSingleton<RabbitMqConnection>();
        services.AddHostedService<RabbitOutboxPublisher>();
        services.AddHostedService<RabbitResultConsumer>();
        services.AddHostedService<RabbitCapabilityConsumer>();
        return services;
    }
}
