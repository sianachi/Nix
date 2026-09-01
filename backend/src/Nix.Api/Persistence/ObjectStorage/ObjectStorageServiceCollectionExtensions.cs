using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Registers private object capability signing.</summary>
public static class ObjectStorageServiceCollectionExtensions
{
    /// <summary>Adds the signer, disabled when the complete section is absent.</summary>
    public static IServiceCollection AddNixObjectStorage(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        var options = new ObjectStorageOptions();
        configuration.GetSection(ObjectStorageOptions.SectionName).Bind(options);
        services.AddSingleton(options);
        services.AddSingleton<S3CapabilitySigner>();
        return services;
    }
}
